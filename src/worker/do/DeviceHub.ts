import { DurableObject } from "cloudflare:workers";

/**
 * One instance per device. Holds the signalling sockets and answers "is this
 * Mac awake right now?".
 *
 * COST CONSTRAINT (PRD 8.6 #1) — this class must only ever use the WebSocket
 * Hibernation API:
 *
 *   - accept with `ctx.acceptWebSocket()`, never `server.accept()`
 *   - handle events with the `webSocketMessage` / `webSocketClose` methods,
 *     never `addEventListener`
 *   - keep no socket references in instance fields; `ctx.getWebSockets()` is
 *     the only way to reach them
 *
 * Doing it the ordinary way keeps the object resident and bills duration for
 * every connected Mac around the clock, which on its own is enough to sink the
 * one-time-purchase model. Keepalives use the auto-response pair below so a
 * ping does not even wake the object.
 */

type Role = "device" | "sender";

interface Attachment {
	role: Role;
	deviceId: string;
	/** Sender sockets only: the transfer they are watching. */
	transferId?: string;
}

export interface DeliveryEvent {
	type: string;
	[key: string]: unknown;
}

export class DeviceHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Answered without waking the object from hibernation.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("expected websocket", { status: 426 });
		}

		const url = new URL(request.url);
		const role = url.searchParams.get("role") === "sender" ? "sender" : "device";
		const deviceId = url.searchParams.get("device") ?? "";
		const transferId = url.searchParams.get("transfer") ?? undefined;

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		// Tags are how we find sockets again after hibernation.
		const tags = [role];
		if (role === "sender" && transferId) tags.push(`t:${transferId}`);
		this.ctx.acceptWebSocket(server, tags);
		server.serializeAttachment({ role, deviceId, transferId } satisfies Attachment);

		if (role === "sender") {
			// A sender's first question is always "is the Mac awake?" (PRD 11.1/11.2).
			this.send(server, { type: "presence", online: this.isDeviceOnline() });
		} else {
			this.broadcastPresence(true);
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") return;
		let parsed: { type?: string };
		try {
			parsed = JSON.parse(message);
		} catch {
			return;
		}
		// State changes go through the REST API so they are transactional against
		// D1 and R2. The socket carries notifications only.
		if (parsed.type === "hello") {
			const attachment = ws.deserializeAttachment() as Attachment | null;
			this.send(ws, {
				type: "hello.ok",
				role: attachment?.role ?? "device",
				online: this.isDeviceOnline(),
			});
		}
	}

	override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		const attachment = ws.deserializeAttachment() as Attachment | null;
		try {
			ws.close(code === 1006 ? 1000 : code, reason);
		} catch {
			// Already closed.
		}
		if (attachment?.role === "device" && !this.isDeviceOnline()) {
			this.broadcastPresence(false);
			await this.touchLastSeen(attachment.deviceId);
		}
	}

	override async webSocketError(ws: WebSocket): Promise<void> {
		const attachment = ws.deserializeAttachment() as Attachment | null;
		if (attachment?.role === "device" && !this.isDeviceOnline()) {
			this.broadcastPresence(false);
		}
	}

	// ---- RPC surface, called from the worker -------------------------------

	/** PRD 11.1/11.2 — drives the "Online" vs "Mac is asleep" copy. */
	isOnline(): boolean {
		return this.isDeviceOnline();
	}

	/** Push a newly readable file to the Mac. No-op when it is asleep: the Mac
	 *  picks it up from GET /api/v1/pending on its next wake (PRD 10.5). */
	notifyDevice(event: DeliveryEvent): void {
		for (const ws of this.ctx.getWebSockets("device")) this.send(ws, event);
	}

	/** Push delivery state back to the browser that uploaded it (PRD 8.3 step 6). */
	notifySender(transferId: string, event: DeliveryEvent): void {
		for (const ws of this.ctx.getWebSockets(`t:${transferId}`)) this.send(ws, event);
	}

	// ---- internals ---------------------------------------------------------

	private isDeviceOnline(): boolean {
		return this.ctx.getWebSockets("device").length > 0;
	}

	private broadcastPresence(online: boolean): void {
		for (const ws of this.ctx.getWebSockets("sender")) {
			this.send(ws, { type: "presence", online });
		}
	}

	private send(ws: WebSocket, event: DeliveryEvent): void {
		try {
			ws.send(JSON.stringify(event));
		} catch {
			// Socket died between lookup and send; nothing to do.
		}
	}

	private async touchLastSeen(deviceId: string): Promise<void> {
		if (!deviceId) return;
		try {
			await this.env.DB.prepare("UPDATE devices SET last_seen = ? WHERE device_id = ?")
				.bind(Date.now(), deviceId)
				.run();
		} catch {
			// Presence bookkeeping must never break a socket teardown.
		}
	}
}
