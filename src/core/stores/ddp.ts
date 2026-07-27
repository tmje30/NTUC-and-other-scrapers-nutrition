/**
 * Minimal Meteor DDP-over-WebSocket client. Sheng Siong (shengsiong.com.sg) is a
 * Meteor app behind Incapsula with no public HTTP/JSON API — data comes via DDP
 * methods. A plain WebSocket connects fine (no auth/token). Node 22+ has a global
 * WebSocket, so no dependency is needed. See LEARNINGS 2026-07-27.
 */

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
			const ws = new WebSocket(this.url);
			this.ws = ws;
			const t = setTimeout(() => reject(new Error("DDP connect timeout")), timeoutMs);
			ws.onopen = () => ws.send(JSON.stringify({ msg: "connect", version: "1", support: ["1"] }));
			ws.onmessage = (e) => {
				let d: any;
				try {
					d = JSON.parse(String((e as MessageEvent).data));
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
			};
			ws.onerror = () => reject(new Error("DDP websocket error"));
			ws.onclose = () => {
				const err = new Error("DDP connection closed");
				for (const p of this.pending.values()) p.reject(err);
				this.pending.clear();
			};
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
