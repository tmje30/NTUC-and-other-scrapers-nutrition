import WebSocket from "ws";

/**
 * Minimal Meteor DDP-over-WebSocket client. Sheng Siong (shengsiong.com.sg) is a
 * Meteor app behind Incapsula with no public HTTP/JSON API — data comes via DDP
 * methods. Uses the `ws` library so we can send browser-like headers (some
 * Incapsula setups reject header-less/datacenter clients). See LEARNINGS.
 */

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

interface Pending {
	resolve: (v: any) => void;
	reject: (e: Error) => void;
}

export class DdpClient {
	private ws: WebSocket | null = null;
	private ready: Promise<void> | null = null;
	private pending = new Map<string, Pending>();
	private nextId = 1;

	constructor(private readonly url: string) {}

	connect(timeoutMs = 20000): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = new Promise<void>((resolve, reject) => {
			const origin = new URL(this.url).origin.replace(/^wss/, "https").replace(/^ws/, "http");
			const ws = new WebSocket(this.url, {
				headers: { "User-Agent": UA, Origin: origin },
			});
			this.ws = ws;
			const t = setTimeout(() => reject(new Error("DDP connect timeout")), timeoutMs);

			ws.on("open", () => ws.send(JSON.stringify({ msg: "connect", version: "1", support: ["1"] })));
			ws.on("message", (raw: WebSocket.RawData) => {
				let d: any;
				try {
					d = JSON.parse(raw.toString());
				} catch {
					return;
				}
				if (d.msg === "connected") {
					clearTimeout(t);
					resolve();
				} else if (d.msg === "ping") {
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
			ws.on("error", (err: Error) => {
				clearTimeout(t);
				reject(new Error(`DDP websocket: ${err.message}`));
			});
			ws.on("close", (code: number, reason: Buffer) => {
				clearTimeout(t);
				const msg = `DDP closed (${code}${reason?.length ? ` ${reason.toString()}` : ""})`;
				const err = new Error(msg);
				for (const p of this.pending.values()) p.reject(err);
				this.pending.clear();
			});
		});
		return this.ready;
	}

	async call<T = any>(method: string, params: unknown[], timeoutMs = 20000): Promise<T> {
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
