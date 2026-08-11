import type { StoreModule, StoreProduct } from "./types.js";
import { marketplaceSize } from "../marketplace-size.js";
import { evaluateInPage } from "../browser-cdp.js";

/**
 * Watsons Singapore — the second quote for the toothpaste and skincare rows.
 *
 * Five Ingredients rows name it (the CeraVe lotion and four Sensodyne toothpastes) and
 * **none of them had a price** before this module existed. They are the same rows Guardian
 * covers, so this is the cross-shop comparison for personal care rather than a new
 * category.
 *
 * ## ⚠️ It renders, then it gets WIPED — read it inside the window
 *
 * This shop collected **two independent "dead end" verdicts** (2026-08-05, and again on
 * 2026-08-11) saying a real browser renders only the footer and the product API never
 * yields. Both were true observations and the wrong conclusion. Measured, headed, from a
 * Singapore residential address on 2026-08-11:
 *
 * ```
 *   settle  4s →     0B    nothing rendered yet
 *   settle  7s →  6285B    52 prices, 96 product links   ✓
 *   settle 11s →  6610B    52 prices, 96 product links   ✓
 *   settle 16s →  6603B    52 prices, 96 product links   ✓
 *   settle 22s →   484B    wiped — footer only
 * ```
 *
 * An Akamai Bot Manager check tears the results down after the fact, so a fixed delay has
 * to thread a window that **fails at both ends** — and too-early and too-late produce the
 * identical empty shell. That is how a working shop reads as permanently blocked.
 *
 * So this never sleeps a fixed time: `waitFor` polls until product links exist and reads
 * immediately, leaving the danger zone before the wipe arrives. See `browser-cdp.ts`.
 *
 * ⚠️ **Headed, and not as a preference.** Headless is detected here exactly as it is by
 * Carousell. That makes this a laptop-only shop — it cannot run in GitHub Actions.
 *
 * ⚠️ **The pack size is in the product NAME**, as at Guardian — "…Whitening 100g",
 * "…Cool Mint 100g" — so it is parsed with `marketplaceSize`, which already handles
 * multipacks ("2X100G" is 200 g) and REJECTS a title stating two different sizes rather
 * than half-reading it.
 */

const BASE = "https://www.watsons.com.sg";

/**
 * Ready = several product links exist. Deliberately `> 3` rather than `> 0`: a single
 * stray link (a promo tile, a "recently viewed" rail) appears well before the grid does,
 * and reading on it would catch a page with one product on it.
 */
const READY = `[...document.querySelectorAll('a[href]')].filter(a => /\\/p\\//i.test(a.getAttribute('href')||'')).length > 3`;

/** Give-up deadline, NOT a plan — the read happens as soon as `READY` is true. */
const DEADLINE_MS = 20_000;

/**
 * One card is one `.productContainer` — 32 of them for "sensodyne toothpaste", matching
 * the 32 products on the page.
 *
 * ⚠️ **The name comes from `.productName`, NOT from the anchor.** A card holds three
 * links to the same product and the FIRST is the image, whose `title` and `innerText` are
 * both empty. Reading the anchor dropped every product on the page for an empty name,
 * while the extractor looked like it was working — 32 cards in, 0 products out.
 *
 * ⚠️ **The price comes from `.formatted-value`.** `[class*="price" i]` matches the whole
 * `.productPrice` block, whose text is `"S$10.20 200 Sold"` — a units-sold count sitting
 * one regex slip away from being read as money.
 */
const EXTRACT = `(() => {
  const txt = (e) => (e && e.innerText ? e.innerText : '').replace(/\\s+/g, ' ').trim();
  const money = (s) => {
    // Always the amount attached to the currency mark, never the first number present.
    const m = /(?:S\\$|SGD)\\s*([\\d,]+(?:\\.\\d{1,2})?)/i.exec(s || '');
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  return [...document.querySelectorAll('.productContainer')].map(c => {
    // The product link is whichever anchor actually points at a product page.
    const a = [...c.querySelectorAll('a[href]')]
      .find(x => /\\/p\\/|^\\//.test(x.getAttribute('href') || '')) || c.querySelector('a[href]');
    const priceText = txt(c.querySelector('.productPrice .formatted-value'))
      || txt(c.querySelector('.formatted-value'))
      || txt(c.querySelector('.productPrice'));
    const strike = c.querySelector('del,s,[class*="was" i],[class*="strike" i],[class*="original" i]');
    return {
      href: a ? a.getAttribute('href') : null,
      name: txt(c.querySelector('.productName')),
      cardText: txt(c),
      price: money(priceText),
      wasPrice: strike ? money(txt(strike)) : null,
    };
  });
})()`;

interface RawCard {
	href: string | null;
	name: string;
	cardText: string;
	price: number | null;
	wasPrice: number | null;
}

export interface WatsonsOptions {
	/** Headless renders nothing here — offered only so that can be re-proved cheaply. */
	headed?: boolean;
	deadlineMs?: number;
}

function mapProduct(c: RawCard): StoreProduct | null {
	// A name is what the size is parsed from, so a card without one is not repairable.
	const name = (c.name || "").trim();
	if (!name || !c.href || c.price == null || c.price <= 0) return null;

	const size = marketplaceSize(name);
	const packWeightG = size.ok ? size.grams : null;
	const volumetric = size.ok ? !!size.volumetric : false;

	// ⚠️ On sale only when the shop states a HIGHER previous price. Watsons decorates
	// cards with "$3 OFF $35" spend-and-save banners that are not this product's discount
	// at all, and reading one as a sale would put a fake −% on the deals page.
	const onSale = c.wasPrice != null && c.wasPrice > c.price;

	return {
		store: "Watsons",
		name,
		priceSgd: c.price,
		packWeightG,
		volumetric,
		unitCount: null,
		pricePer100g: packWeightG && packWeightG > 0 ? (c.price / packWeightG) * 100 : null,
		dietaryAttributes: [],
		onSale,
		listPriceSgd: onSale ? c.wasPrice : null,
		saleEndsAt: null,
		url: c.href.startsWith("http") ? c.href : `${BASE}${c.href}`,
	};
}

class Watsons implements StoreModule {
	readonly name = "Watsons";

	constructor(private opts: WatsonsOptions = {}) {}

	async search(term: string): Promise<StoreProduct[]> {
		const url = `${BASE}/search?text=${encodeURIComponent(term)}`;
		const res = await evaluateInPage(url, EXTRACT, {
			// Headed by default — see the header. Headless returns the footer and nothing else.
			headed: this.opts.headed ?? true,
			waitFor: READY,
			settleMs: this.opts.deadlineMs ?? DEADLINE_MS,
			pollMs: 400,
		});
		const rows = (res.value as RawCard[]) ?? [];
		const out: StoreProduct[] = [];
		const seen = new Set<string>();
		for (const c of rows) {
			const p = mapProduct(c);
			if (!p || seen.has(p.url)) continue;
			seen.add(p.url);
			out.push(p);
		}
		return out;
	}
}

export const watsons = new Watsons();
export { Watsons };
