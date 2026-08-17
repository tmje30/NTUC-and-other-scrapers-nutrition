import { Carousell, workerHtmlFetcher } from "./carousell.js";

/**
 * Carousell, fetched **through the Cloudflare Worker** and parsed from raw HTML.
 *
 * The last shop to leave the laptop. Two separate beliefs had to be corrected first,
 * and both were about the measuring, not the shop:
 *
 * 1. **"Carousell needs a real browser."** True from outside Singapore, and only
 *    there. From `ss-worker` in `SIN` a plain `fetch` returns the whole search page —
 *    2.29 MB, 43–47 listings, titles and prices server-rendered. The "shell" the old
 *    comment describes was the US response.
 * 2. **"Listing pages are plain-fetchable."** Also true only from Singapore; a US
 *    runner gets 403 on those too. Both legs therefore go through the Worker, which
 *    is why `readListing` takes the same fetcher as the search.
 *
 * ⚠️ **No browser is launched on this path at all**, so it runs in GitHub Actions
 * where `browser-cdp.ts` cannot. The laptop's `carousell` export is untouched and
 * still drives Chrome — that path has months of measurements behind it and there was
 * no reason to disturb it.
 *
 * ⚠️ **It throws rather than returning `[]`.** A missing secret or a Worker that
 * refuses the host must surface as an error `scanNewItem` records against Carousell.
 * An empty array is indistinguishable from "this marketplace has none", which is how
 * a broken scraper looks healthy for weeks — the failure this module's own header has
 * warned about since it was written.
 */

/**
 * The `/shop` route on `ss-worker`. Its host allowlist is the security model and
 * lives in the Worker, not here — see `ss-worker/worker.ts`.
 */
const DEFAULT_SHOP_URL = "https://ss-worker.tmje30.workers.dev/shop";

function shopUrl(): string {
	const explicit = process.env.SS_WORKER_SHOP_URL;
	if (explicit) return explicit;
	// ⚠️ Derived from SS_WORKER_URL when that is set so a preview deployment does not
	// need two variables kept in step — pointing one at a preview and leaving the
	// other on production is the kind of split that produces a confusing half-failure.
	const scan = process.env.SS_WORKER_URL;
	if (scan) return scan.replace(/\/scan\/?$/, "/shop");
	return DEFAULT_SHOP_URL;
}

export const carousellViaWorker = new Carousell({
	fetchHtml: async (url) => {
		const secret = process.env.SCAN_SECRET;
		if (!secret) {
			throw new Error(
				"SCAN_SECRET is not set — cannot reach Carousell through ss-worker. Set it in .env locally, or as a repository secret for Actions.",
			);
		}
		return workerHtmlFetcher(shopUrl(), secret)(url);
	},
});
