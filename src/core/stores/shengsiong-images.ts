/**
 * Sheng Siong pack-shot URLs, built from what its product record actually gives us.
 *
 * **Why this exists.** Sheng Siong publishes no nutrition data of any kind — no
 * panel field, no structured markup, nothing `parseNutritionPanel` can read. So the
 * free path is closed to it forever, and until 2026-08-04 every Sheng Siong product
 * fell through to the most expensive lookup there is: `web_fetch` cannot read the
 * site either (Incapsula — see `UNFETCHABLE_DOMAINS`), so the model could not even
 * fall back to the product page and had to guess from a web search at ~$0.29.
 *
 * But the nutrition panel IS there, photographed on the back of the pack. Verified
 * 2026-08-04 on "Bake For You Peanut Butter - Crunchy": the `lg` back shot is sharp
 * enough to read and even carries a **Per 100g** column, so it needs no serving-size
 * scaling at all. That drops Sheng Siong from ~$0.29 to ~$0.03 — the single biggest
 * remaining saving in the project, on its worst-served store.
 *
 * **The shape of the data, and why it needs building rather than reading.**
 * FairPrice hands over a finished list of URLs with the view baked into each
 * filename (`_BXL1_` is the back). Sheng Siong gives one opaque key and a count:
 *
 *   imgKey   "qmuntLDsvIewDRGoQl2yWBoTTNqsxB"   the whole series
 *   totalImg 3                                   how many exist
 *
 * → `<BASE>/{size}/{imgKey}.{0..totalImg-1}.jpg`
 *
 * ⚠️ **`totalImg` is load-bearing.** Asking for an index past the end returns a
 * **403**, not a 404 or an empty body — and an unreachable image is one the
 * Anthropic API will fail on rather than skip. Never guess the count.
 *
 * ⚠️ **`totalImg` is in the DETAIL record only** (`Products.getOneByIdOrSlug`), not
 * in the search results the daily scan uses. The extension calls the detail method
 * already and gets it free; anything driven by search has to establish the count
 * some other way before it can build past index 0.
 *
 * ⚠️ **Index 0 is the front**, every time — it is the key the search results use as
 * the thumbnail. It is also the marketing face, which is exactly what produced the
 * bogus 24.8 g protein reading on frozen chicken. This module returns it anyway, in
 * order: the caller passes the whole list to `packShotsFor`, which is the one place
 * allowed to decide what a lookup may see. Filtering here would put that rule in
 * two places.
 *
 * The S3 bucket is public and **not** behind Incapsula, so these URLs are reachable
 * by ordinary `fetch` and by the Anthropic API's own image fetcher — unlike every
 * other Sheng Siong URL in this project.
 */

const BASE = "https://ssecomm.s3.ap-southeast-1.amazonaws.com/products";

/**
 * Largest size the bucket serves. Measured 2026-08-04: `sm` 17 KB, `md` 85 KB,
 * `lg` 256 KB; `xl`, `org`, `original` and the bare path all 403.
 *
 * `lg` and not `md` because the whole point is reading small print off a photograph
 * of a jar — and the model's own image pipeline downsamples anyway, so the cost of
 * the larger file is bandwidth we do not pay for rather than tokens we do.
 */
const SIZE = "lg";

/** How many images one product may contribute, before `packShotsFor` narrows further. */
const MAX_IMAGES = 6;

/**
 * Every pack-shot URL for a product, index 0 (front) first.
 *
 * Returns `[]` for a missing key or a count below 1, which is the honest answer for
 * a product with no photography — and leaves the lookup exactly as it was.
 */
export function shengSiongPackShots(imgKey: unknown, totalImg: unknown): string[] {
	const key = typeof imgKey === "string" ? imgKey.trim() : "";
	// The key goes into a URL path, so refuse anything that isn't the opaque
	// alphanumeric token the API actually returns. A stray slash or dot would
	// silently address a different object.
	if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return [];
	const n = Number(totalImg);
	if (!Number.isFinite(n) || n < 1) return [];
	const count = Math.min(Math.floor(n), MAX_IMAGES);
	return Array.from({ length: count }, (_, i) => `${BASE}/${SIZE}/${key}.${i}.jpg`);
}

/**
 * The pack shots for a product whose COUNT we don't know — established by asking
 * the bucket, one cheap request at a time.
 *
 * **Why this exists.** `totalImg` lives only in the detail record, and the daily
 * scan only ever searches. Without the count, building past index 0 is a guess, and
 * a wrong guess is not a missing image — it is a **403** that fails the entire
 * lookup, because the Anthropic API fetches these URLs itself and an unreachable
 * one is an error rather than something it skips.
 *
 * So: probe. The bucket is public, not behind Incapsula, and a HEAD is a few
 * hundred bytes. Only ever called for products that actually reached the page —
 * a couple of dozen a day, not the 1,100-odd the scan returns.
 *
 * Indices are contiguous (`0 … totalImg-1`), so the first miss ends the series and
 * there is no point looking further. `max` caps it at the two `packShotsFor` would
 * keep anyway.
 *
 * Index 0 is included in the result without being probed — it always exists, it is
 * the thumbnail the search results already use — so that the caller can keep handing
 * the whole series to `packShotsFor` and let that one place decide the front is not
 * a label shot.
 *
 * Never throws: a network failure, a timeout or a 403 all mean "no more images",
 * and the lookup falls back to the text-only path it had before.
 */
export async function resolveShengSiongPackShots(
	imgKey: unknown,
	max = 2,
	timeoutMs = 4000,
): Promise<string[]> {
	// Reuse the builder's validation and URL shape by asking for a generous series,
	// then confirming which of them are real.
	const candidates = shengSiongPackShots(imgKey, max + 1);
	if (!candidates.length) return [];

	const found = [candidates[0]];
	for (const url of candidates.slice(1)) {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), timeoutMs);
		try {
			const res = await fetch(url, { method: "HEAD", signal: ctl.signal });
			if (!res.ok) break; // 403 — past the end of the series
			found.push(url);
		} catch {
			break; // offline, aborted, blocked: treat as the end
		} finally {
			clearTimeout(timer);
		}
	}
	return found;
}

/**
 * Does this URL look like one of ours, and which view is it?
 *
 * Exported for `selectPackShots`, which has to classify a mixed bag of URLs from
 * whichever store the product came from. Returns the index (0 = front) or null.
 */
export function shengSiongViewIndex(url: string): number | null {
	const m = /ssecomm\.s3\.[^/]+\.amazonaws\.com\/products\/(?:sm|md|lg)\/[A-Za-z0-9_-]+\.(\d+)\.jpg$/i.exec(url);
	return m ? Number(m[1]) : null;
}
