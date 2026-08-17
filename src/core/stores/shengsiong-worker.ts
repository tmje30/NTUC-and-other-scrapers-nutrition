import type { StoreModule, StoreProduct } from "./types.js";

/**
 * Sheng Siong, searched **through the Cloudflare Worker** instead of directly.
 *
 * This is what lets new-item pricing run in GitHub Actions. Sheng Siong answers
 * Singapore and challenges everywhere else, and a GitHub runner is US-hosted — so
 * `stores/shengsiong.ts` returns nothing from the cloud, every time. `ss-worker`
 * already runs the identical scan from a Durable Object pinned to Singapore, so this
 * module borrows it rather than duplicating the DDP client on this side.
 *
 * ```
 *   Actions (US) ──HTTPS──▶ ss-worker ──DDP──▶ Sheng Siong
 *                            (SIN)
 * ```
 *
 * ⚠️⚠️ **`force=1` is REQUIRED, and leaving it off fails SILENTLY.** The Worker's
 * freshness check runs *before* the dry-run branch: with today's scan file already
 * committed — which it is, every morning, by 09:01 — a request without `force`
 * returns `{"status":"already-fresh"}` and **no products at all**. Not an error, not
 * a 4xx: a 200 with nothing in it, which reads exactly like "Sheng Siong doesn't
 * stock that". Measured 2026-08-17. This is the same silent-zero trap
 * `new-items.ts` already warns about for `shengsiong-file`, arriving by a new road.
 *
 * ⚠️ **`dryRun=1` is what makes `force=1` safe, and BOTH sides enforce it.** `force`
 * alone would run a real scan and overwrite `data/shengsiong-latest.json` with a
 * one-term "scan" that `isUsableScan` would happily call fresh — destroying the
 * morning's 600-product file and taking Sheng Siong off the deals page for the day.
 * With `dryRun` the Worker returns the results and writes nothing; it also refuses to
 * honour `terms` at all unless `dryRun` is set (`ss-worker/worker.ts`), so a caller
 * cannot get the term override without the guard. **Never send `terms` without
 * `dryRun`.**
 *
 * ⚠️ **It throws rather than returning `[]`.** A missing env var or a Worker that
 * cannot reach the shop must surface as an error `scanNewItem` records against the
 * store, because an empty array here is indistinguishable from "not stocked" and
 * would quietly drop a whole shop from every new-item card.
 */

/** Where the Worker lives. Overridable so a preview deploy can be pointed at. */
const DEFAULT_URL = "https://ss-worker.tmje30.workers.dev/scan";

/**
 * A term search is one WebSocket round trip against a shop that has been nothing
 * but cooperative; the Worker's own scan measures ~60 s for 47 terms. 90 s is slack
 * for one term, not a budget.
 */
const TIMEOUT_MS = 90_000;

export interface ShengSiongWorkerOptions {
	url?: string;
	secret?: string;
}

export class ShengSiongViaWorker implements StoreModule {
	// ⚠️ The SAME name the direct module reports. Everything downstream keys on
	// `product.store` — `found` in `scanNewItem`, the per-shop dedupe, the offer
	// rows on the page — so calling this "Sheng Siong (Worker)" would present the
	// transport as if it were a different shop.
	readonly name = "Sheng Siong";

	constructor(private readonly opts: ShengSiongWorkerOptions = {}) {}

	async search(term: string): Promise<StoreProduct[]> {
		const url = this.opts.url ?? process.env.SS_WORKER_URL ?? DEFAULT_URL;
		const secret = this.opts.secret ?? process.env.SCAN_SECRET;
		if (!secret) {
			throw new Error(
				"SCAN_SECRET is not set — cannot reach ss-worker. Set it in .env locally, or as a repository secret for Actions.",
			);
		}

		const qs = new URLSearchParams({
			dryRun: "1", // never writes; also what unlocks `terms` at all
			force: "1", // ⚠️ without this, today's fresh file short-circuits to zero products
			terms: term,
			source: "new-items",
		});

		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
		let res: Response;
		try {
			res = await fetch(`${url}?${qs}`, { headers: { "X-Scan-Secret": secret }, signal: ctl.signal });
		} finally {
			clearTimeout(t);
		}

		const body: any = await res.json().catch(() => null);
		if (!res.ok || body?.ok !== true) {
			// The Worker reports the datacenter it ran in and what each placement
			// candidate answered; that is the whole diagnosis for a failed run, so it
			// goes into the message rather than being reduced to a status code.
			const why = body?.reason ?? `HTTP ${res.status}`;
			throw new Error(`ss-worker: ${why}${body?.colo ? ` (colo=${body.colo})` : ""}`);
        }
		if (body.status !== "dry-run") {
			// The `already-fresh` case lands here rather than silently returning [].
			throw new Error(
				`ss-worker returned status "${body.status}", expected "dry-run" — a term search must send force=1 as well as dryRun=1.`,
			);
		}

		// `results` is keyed by the term the Worker searched. Read the single bucket
		// rather than trusting the key to round-trip our exact string through the
		// query string and back.
		const buckets: Record<string, unknown[]> = body?.file?.results ?? {};
		const rows = Object.values(buckets).flat();
		// `mapProduct` in `ss-worker/scan.ts` already emits this shape field for field —
		// it is the same mapping the committed daily file carries.
		return rows as StoreProduct[];
	}
}

export const shengsiongViaWorker = new ShengSiongViaWorker();
