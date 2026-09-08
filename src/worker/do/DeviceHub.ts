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

type Role = "device" | "sender" | "signal";

interface Attachment {
	role: Role;
	deviceId: string;
	/** Sender sockets only: the transfer they are watching. */
	transferId?: string;
	/** Signal sockets only: the LAN negotiation they belong to (PRD 8.2). */
	sessionId?: string;
	/** Signal sockets only: how much signalling this page has pushed through. */
	signalCount?: number;
}

/**
 * Cost fences on the signalling relay (PRD 8.6 #1). An idle socket hibernates
 * and bills nothing; every *message* wakes the object, and `/api/v1/ws/lan` is
 * reachable by anyone holding an inbox link. Host-candidate-only negotiation
 * needs an offer, an answer and a handful of candidates — single digits — so a
 * ceiling of 64 is far above any honest session and still bounds the bill.
 */
const MAX_SIGNAL_BYTES = 8 * 1024;
const MAX_SIGNAL_MESSAGES = 64;

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
		const requested = url.searchParams.get("role");
		const role: Role = requested === "sender" ? "sender" : requested === "signal" ? "signal" : "device";
		const deviceId = url.searchParams.get("device") ?? "";
		const transferId = url.searchParams.get("transfer") ?? undefined;
		const sessionId = url.searchParams.get("session") ?? undefined;

		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		// Tags are how we find sockets again after hibernation.
		const tags: string[] = [role];
		if (role === "sender" && transferId) tags.push(`t:${transferId}`);
		if (role === "signal" && sessionId) tags.push(`s:${sessionId}`);
		this.ctx.acceptWebSocket(server, tags);
		server.serializeAttachment({
			role,
			deviceId,
			transferId,
			sessionId,
			signalCount: 0,
		} satisfies Attachment);

		if (role === "device") {
			this.broadcastPresence(true);
		} else {
			// A sender's first question is always "is the Mac awake?" (PRD 11.1/11.2),
			// and a signal socket needs the same answer before it offers to nobody.
			this.send(server, { type: "presence", online: this.isDeviceOnline() });
		}

		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") return;
		if (message.length > MAX_SIGNAL_BYTES) return;
		let parsed: { type?: string; session?: unknown; payload?: unknown };
		try {
			parsed = JSON.parse(message);
		} catch {
			return;
		}
		const attachment = ws.deserializeAttachment() as Attachment | null;

		// State changes go through the REST API so they are transactional against
		// D1 and R2. The socket carries notifications and WebRTC signalling only —
		// and the signalling is relayed opaquely, so this object never has to know
		// what an SDP offer or an ICE candidate is.
		if (parsed.type === "hello") {
			this.send(ws, {
				type: "hello.ok",
				role: attachment?.role ?? "device",
				online: this.isDeviceOnline(),
			});
			return;
		}

		if (parsed.type === "signal") this.relaySignal(ws, attachment, parsed.session, parsed.payload);
	}

	/**
	 * PRD 8.2 — carries the offer/answer/candidate exchange between one send page
	 * and the Mac, in both directions.
	 *
	 * The session id is stamped from the socket's own attachment on the way out
	 * and matched against a tag on the way back, so a sender can neither claim
	 * another's session nor address anything except the device that issued its
	 * token. `MAX_SIGNAL_MESSAGES` is the cost fence on the send page's side:
	 * this is the one path into the object that an unauthenticated stranger can
	 * reach, and every message through it wakes the object (PRD 8.6 #1).
	 */
	private relaySignal(
		ws: WebSocket,
		attachment: Attachment | null,
		session: unknown,
		payload: unknown,
	): void {
		if (!attachment || payload === undefined) return;

		if (attachment.role === "signal") {
			/*
			 * The budget is charged to *send pages* only, never to the Mac.
			 *
			 * A signal socket is one page's one negotiation, reachable by anyone
			 * holding the link, and it is finished after a handful of messages —
			 * so a ceiling bounds a stranger without ever being met honestly. The
			 * device socket is the opposite of all three: device-authenticated,
			 * long-lived, and answering every session this Mac will ever be
			 * offered. Charging it too would spend the budget across unrelated
			 * transfers and then silently stop answering — LAN would work for the
			 * first few negotiations after each reconnect and quietly stop, which
			 * is the worst possible shape for a bug on a fallback path.
			 */
			const used = attachment.signalCount ?? 0;
			if (used >= MAX_SIGNAL_MESSAGES) return;
			ws.serializeAttachment({ ...attachment, signalCount: used + 1 } satisfies Attachment);

			if (!attachment.sessionId) return;
			for (const device of this.ctx.getWebSockets("device")) {
				this.send(device, { type: "signal", session: attachment.sessionId, payload });
			}
			return;
		}

		// The Mac answering. It echoes back the session it was given; the tag
		// lookup is what makes that safe — an id it invented reaches nobody.
		if (attachment.role === "device") {
			if (typeof session !== "string" || !session) return;
			for (const sender of this.ctx.getWebSockets(`s:${session}`)) {
				this.send(sender, { type: "signal", payload });
			}
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
		// Signal sockets too: a send page that opened while the Mac was asleep uses
		// this to start negotiating the moment it wakes, rather than deciding once
		// at page load that LAN was impossible (PRD 8.2).
		for (const tag of ["sender", "signal"]) {
			for (const ws of this.ctx.getWebSockets(tag)) {
				this.send(ws, { type: "presence", online });
			}
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
