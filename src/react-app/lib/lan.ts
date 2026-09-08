/**
 * PRD 8.2 — negotiating the LAN direct path.
 *
 * Host candidates only, no STUN and no TURN (`iceServers: []`). That is the
 * cheap 20% of WebRTC: it covers the one case where peer to peer genuinely
 * beats the relay — a phone and a Mac on the same Wi-Fi — and it needs no
 * infrastructure at all. Anything that is not on the same subnet simply fails
 * to connect, which is not a defect: the relay is always there.
 *
 * Two things are worth knowing before reading this.
 *
 * It runs at page load, not at send time. The signalling token comes back from
 * `/api/v1/resolve` (an upload token cannot be used, because it does not exist
 * until a transfer has already been booked), so negotiation can start while
 * someone is still choosing a file. By the time they press send the channel is
 * usually open and PRD 8.1's two-second race never has to be run.
 *
 * And it never rejects. Every failure — no route between the two machines, ICE
 * timing out, the Mac's local network permission being denied on macOS 15,
 * WebRTC missing entirely — resolves `null` and the caller falls back to the
 * relay. A sender is never shown a failure for the network being what it is.
 */

/** How long to keep gathering before giving up. Generous: this is not the
 *  send-time deadline, only a cap so a dead negotiation cannot leak. */
const NEGOTIATION_TIMEOUT_MS = 15_000;

export interface LanSession {
	/** The open DataChannel, or null once the LAN path is known to be unavailable. */
	ready: Promise<RTCDataChannel | null>;
	close(): void;
}

interface SignalEnvelope {
	type?: string;
	payload?: { kind?: string; sdp?: string; candidate?: RTCIceCandidateInit };
	online?: boolean;
}

export function openLanSession(signalToken: string): LanSession {
	let settle: (channel: RTCDataChannel | null) => void = () => {};
	const ready = new Promise<RTCDataChannel | null>((resolve) => {
		settle = resolve;
	});

	if (typeof RTCPeerConnection === "undefined" || typeof WebSocket === "undefined") {
		settle(null);
		return { ready, close: () => {} };
	}

	let closed = false;
	let socket: WebSocket | null = null;
	let peer: RTCPeerConnection | null = null;

	const finish = (channel: RTCDataChannel | null) => {
		settle(channel);
		// The signalling socket has done its job once the channel is open. Closing
		// it drops a Durable Object connection that would otherwise sit there for
		// the life of the page (PRD 8.6 #1) — the channel itself is peer to peer
		// and needs no server from here on.
		socket?.close();
		socket = null;
		if (!channel) teardown();
	};

	const teardown = () => {
		if (closed) return;
		closed = true;
		try {
			peer?.close();
		} catch {
			// Already gone.
		}
		peer = null;
		socket?.close();
		socket = null;
	};

	try {
		peer = new RTCPeerConnection({ iceServers: [] });
	} catch {
		settle(null);
		return { ready, close: teardown };
	}

	// The browser opens the channel and the Mac answers, so `ordered` is settled
	// here. It must stay true: the ciphertext is one unframed stream
	// (docs/wire-format.md), so a reordered frame does not lose one chunk, it
	// fails the GCM tag of every chunk after it.
	const channel = peer.createDataChannel("stolnk", { ordered: true });
	channel.binaryType = "arraybuffer";

	const timer = setTimeout(() => finish(null), NEGOTIATION_TIMEOUT_MS);
	const done = (result: RTCDataChannel | null) => {
		clearTimeout(timer);
		finish(result);
	};

	channel.addEventListener("open", () => done(channel));
	channel.addEventListener("error", () => done(null));
	peer.addEventListener("connectionstatechange", () => {
		const state = peer?.connectionState;
		if (state === "failed" || state === "closed") done(null);
	});

	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	socket = new WebSocket(
		`${protocol}//${location.host}/api/v1/ws/lan?token=${encodeURIComponent(signalToken)}`,
	);

	const send = (payload: unknown) => {
		if (socket?.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ type: "signal", payload }));
		}
	};

	peer.addEventListener("icecandidate", (event) => {
		// The null candidate marks the end of gathering; with no STUN server there
		// is nothing after the host candidates anyway.
		if (event.candidate) send({ kind: "ice", candidate: event.candidate.toJSON() });
	});

	socket.addEventListener("error", () => done(null));
	socket.addEventListener("close", () => {
		// Only a failure if the channel never opened; after that this socket is
		// deliberately closed by `finish`.
		if (channel.readyState !== "open") done(null);
	});

	socket.addEventListener("open", () => {
		void (async () => {
			try {
				const offer = await peer!.createOffer();
				await peer!.setLocalDescription(offer);
				send({ kind: "offer", sdp: offer.sdp });
			} catch {
				done(null);
			}
		})();
	});

	socket.addEventListener("message", (event) => {
		if (typeof event.data !== "string" || event.data === "pong") return;
		let message: SignalEnvelope;
		try {
			message = JSON.parse(event.data);
		} catch {
			return;
		}

		// The Mac went away mid-negotiation. Give up now rather than sitting out
		// the ICE timeout: the sender is waiting on this to decide a transport.
		if (message.type === "presence" && message.online === false) {
			if (channel.readyState !== "open") done(null);
			return;
		}
		if (message.type !== "signal" || !message.payload) return;

		void (async () => {
			try {
				if (message.payload!.kind === "answer" && message.payload!.sdp) {
					await peer!.setRemoteDescription({ type: "answer", sdp: message.payload!.sdp });
				} else if (message.payload!.kind === "ice" && message.payload!.candidate) {
					await peer!.addIceCandidate(message.payload!.candidate);
				}
			} catch {
				// A candidate that will not parse is one route lost, not the session.
			}
		})();
	});

	return { ready, close: teardown };
}
