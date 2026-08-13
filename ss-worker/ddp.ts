/**
 * Worker-native DDP client — the Cloudflare twin of `src/core/stores/ddp.ts`.
 *
 * The Node original cannot be reused: it is built on the `ws` npm package
 * (`new WebSocket(url, {headers})`, `ws.on("message", …)`), and Workers have no
 * such thing. A Worker opens a socket by *fetching* with an `Upgrade` header and
 * reading `response.webSocket` off the reply. Everything below the transport is
 * the same protocol, so this file deliberately mirrors the original's semantics
 * one for one — same connect handshake, same ping/pong, same pending-call map,
 * same error text.
 *
 * ⚠️ **Keep the two in step.** They are the same protocol against the same
 * server; a fix to one that is not applied to the other is a difference between
 * what the laptop scans and what the cloud scans, which shows up as prices that
 * disagree and no obvious reason why.
 *
 * ⚠️ **No Incapsula cookie and no browser here, and that is measured, not
 * assumed.** From Cloudflare's Singapore colo Sheng Siong completes the upgrade
 * with a plain `101` and answers the DDP handshake with a real Meteor session.
 * The whole `incapsula.ts` cookie-minting subsystem exists for requests from
 * outside Singapore; inside it, there is nothing to get past. If this ever
 * starts returning `200` instead of `101`, check where the Worker is running
 * (`cdn-cgi/trace`) before assuming the WAF changed — that mistake has been made
 * three times in this project.
 */

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface Pending {
	resolve: (v: any) => void;
	reject: (e: Error) => void;
}

export class WorkerDdpClient {
	private ws: WebSocket | null = null;
	private ready: Promise<void> | null = null;
	private pending = new Map<string, Pending>();
	private nextId = 1;

	/**
	 * @param url `https://…/websocket`. ⚠️ **Not `wss://`** — the Node client dials
	 * `wss://`, but the Workers upgrade goes through `fetch`, which only speaks
	 * `http(s)`. Same endpoint, different scheme, and `wss://` here fails to fetch.
	 */
	constructor(private readonly url: string) {}

	connect(timeoutMs = 20_000): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = (async () => {
			const origin = new URL(this.url).origin;
			const res = await fetch(this.url, {
				headers: { Upgrade: "websocket", "User-Agent": UA, Origin: origin },
			});

			// ⚠️ A 200 here is the challenge page, not a failed handshake — Incapsula
			// answers the upgrade with ordinary HTML rather than refusing it. That is
			// the single signal that says "this Worker is not in Singapore".
			if (res.status !== 101 || !res.webSocket) {
				const body = await res.text().catch(() => "");
				throw new Error(
					`DDP upgrade failed: ${res.status}${res.status === 200 ? " (challenge page, not a socket)" : ""}` +
						(body ? ` — ${body.slice(0, 200)}` : ""),
				);
			}

			const ws = res.webSocket;
			ws.accept();
			this.ws = ws;

			return await new Promise<void>((resolve, reject) => {
				const t = setTimeout(() => reject(new Error("DDP connect timeout")), timeoutMs);

				ws.addEventListener("message", (ev: MessageEvent) => {
					let d: any;
					try {
						d = JSON.parse(String(ev.data));
					} catch {
						return;
					}
					if (d.msg === "connected") {
						clearTimeout(t);
						resolve();
					} else if (d.msg === "ping") {
						// Meteor drops a client that stops answering pings. A 70-term scan
						// takes minutes, so this is not optional.
						ws.send(JSON.stringify({ msg: "pong", id: d.id }));
					} else if (d.msg === "result") {
						const p = this.pending.get(d.id);
						if (p) {
							this.pending.delete(d.id);
							d.error
								? p.reject(new Error(d.error.reason || d.error.message || "DDP error"))
								: p.resolve(d.result);
						}
					}
				});

				ws.addEventListener("error", () => {
					clearTimeout(t);
					reject(new Error("DDP websocket error"));
				});

				// ⚠️ Every in-flight call must be rejected on close, or a socket that
				// dies mid-scan leaves its promises pending forever and the Worker is
				// killed by its own wall-clock limit with no error to show for it.
				ws.addEventListener("close", (ev: CloseEvent) => {
					clearTimeout(t);
					const err = new Error(`DDP closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})`);
					for (const p of this.pending.values()) p.reject(err);
					this.pending.clear();
				});

				ws.send(JSON.stringify({ msg: "connect", version: "1", support: ["1"] }));
			});
		})();
		return this.ready;
	}

	async call<T = any>(method: string, params: unknown[], timeoutMs = 20_000): Promise<T> {
		await this.connect();
		const id = String(this.nextId++);
		return new Promise<T>((resolve, reject) => {
			const t = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`DDP method ${method} timeout`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(t);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(t);
					reject(e);
				},
			});
			this.ws!.send(JSON.stringify({ msg: "method", method, params, id }));
		});
	}

	close(): void {
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
		this.ws = null;
		this.ready = null;
	}
}
