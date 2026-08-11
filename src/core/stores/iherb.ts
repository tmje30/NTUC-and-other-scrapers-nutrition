import type { StoreModule, StoreProduct } from "./types.js";
import { marketplaceSize } from "../marketplace-size.js";
import { evaluateInPage } from "../browser-cdp.js";

/**
 * iHerb Singapore — the supplement shop tagged on five Ingredients rows.
 *
 * Plain `fetch` gets a **403**: iHerb bot-walls an ordinary request outright. A real
 * HEADED Chrome renders the search page fully — measured 2026-08-11 from a Singapore
 * residential address: 11 KB of text, **150 price nodes carrying money, 144 product
 * links**, real titles. Headless is detected here as it is at Carousell and Watsons, so
 * like those this is a **laptop-only** route and cannot run in GitHub Actions.
 *
 * Unlike Watsons there is no wipe — the page renders and stays. `waitFor` is still used
 * rather than a fixed sleep, because the alternative is picking a delay that is either
 * wasteful or occasionally too short, and polling is neither.
 *
 * ## ⚠️ Most of this catalogue has NO pack size, and that is the honest answer
 *
 * iHerb sells capsules, and a capsule title states a **dose and a count**, not a weight:
 * "Gold C®, USP Grade Vitamin C, **1,000 mg**, **240 Veggie Capsules**". The 1,000 mg is
 * what one capsule contains. Reading it as the pack would price a $22.98 bottle as a 1 g
 * purchase — off by 240× — and the direction such errors take is always the one that
 * looks like a bargain.
 *
 * `marketplaceSize` already refuses these (verified against ten real iHerb titles on
 * 2026-08-11: every `mg`-and-capsules title returns `REJECTED — none`, while
 * "11.75 fl oz (347 ml)" and "2.5 kg" parse correctly). So this module inherits the right
 * behaviour for free and **drops capsule products rather than guessing**.
 *
 * ⚠️ **Do not "fix" this by multiplying dose × count.** 240 × 1,000 mg = 240 g is
 * arithmetically true and commercially meaningless: it is 240 g of active ingredient, not
 * a 240 g pack, and comparing it per-kilo against a tub of powder is comparing different
 * things.
 *
 * ## The capsule COUNT is the size — the rows say so
 *
 * Every Ingredients row tagged Iherb is `By Unit` and already priced by the piece:
 * `Multi-vitamin (Life Extension)` at $28.72 / 120 pcs, `Omega 3 [california gold]` at
 * $39.97 / 120 pcs. So the unit here is the capsule, exactly as the note above predicted,
 * and `unitCount` is what makes this shop usable at all.
 *
 * ⚠️ Without it every candidate is REFUSED rather than mismatched — `unitKindAgrees`
 * requires a `By Unit` row to meet a product with a count, so a module returning
 * `unitCount: null` yields zero on every one of its own rows while looking like it simply
 * found nothing. Measured before this was added: 0 candidates across all 5 rows.
 *
 * The practical shape of this shop: capsules are priced per piece, liquids and powders per
 * 100 g, and a title stating neither is dropped rather than guessed.
 */

const BASE = "https://sg.iherb.com";

/** Ready = a grid of product links exists, not one stray promo tile. */
const READY = `[...document.querySelectorAll('a[href]')].filter(a => (a.getAttribute('href')||'').indexOf('/pr/') >= 0).length > 3`;

/** Give-up deadline, not a plan — the read happens as soon as `READY` is true. */
const DEADLINE_MS = 25_000;

/**
 * ⚠️ `.product-cell-container` is the card, and the name is `.product-title`.
 *
 * Not the anchor: a card carries several links to the same product (image, title,
 * "Add to Cart", and a REVIEWS link whose text is "4.8/5 - 385,474 Reviews"). Taking the
 * first anchor's text would have filed a review score as a product name.
 */
const EXTRACT = `(() => {
  const txt = (e) => (e && e.innerText ? e.innerText : '').replace(/\\s+/g, ' ').trim();
  const money = (s) => {
    // Always the amount attached to the currency mark. Card text also carries
    // "40K+ sold in 30 days" and a review count, both of which are numbers.
    const m = /(?:SG\\$|S\\$|\\$)\\s*([\\d,]+(?:\\.\\d{1,2})?)/i.exec(s || '');
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  return [...document.querySelectorAll('.product-cell-container')].map(c => {
    const a = c.querySelector('a[href*="/pr/"]');
    const strike = c.querySelector('del,s,[class*="discontinued" i],[class*="list-price" i],[class*="was" i]');
    return {
      href: a ? a.getAttribute('href') : null,
      // The link's title attribute is the FULL name; .product-title is visually clamped
      // but its innerText is complete, so either works — prefer the attribute.
      name: (a && a.getAttribute('title')) || txt(c.querySelector('.product-title')),
      price: money(txt(c.querySelector('.price'))),
      wasPrice: strike ? money(txt(strike)) : null,
    };
  });
})()`;

interface RawCard {
	href: string | null;
	name: string | null;
	price: number | null;
	wasPrice: number | null;
}

export interface IherbOptions {
	/** Headless is detected — offered only so that can be re-proved cheaply. */
	headed?: boolean;
	deadlineMs?: number;
}

/**
 * How many pieces the pack holds — "240 Veggie Capsules", "250 Tablets", "30 Packets".
 *
 * ⚠️ **The count is the number ADJACENT to the piece word, never the first number in the
 * title.** "Gold C®, USP Grade Vitamin C, 1,000 mg, 240 Veggie Capsules" opens with a
 * 1,000 mg dose; reading that as the count would price a 240-capsule bottle as a
 * 1,000-piece one and make it look four times cheaper per capsule.
 *
 * The optional adjective slot ("Veggie", "Vegetarian", "Vegan", "Chewable") is bounded to
 * two words so it cannot leap across a comma into the next clause.
 */
export function capsuleCount(title: string): number | null {
	const m = /\b(\d{1,4})\s+(?:[a-z-]+\s+){0,2}?(capsules?|caps|tablets?|softgels?|soft gels?|gummies|gummy|lozenges?|packets?|sachets?|count|ct)\b/i.exec(
		title,
	);
	if (!m) return null;
	const n = Number(m[1]);
	return Number.isFinite(n) && n > 0 && n <= 5000 ? n : null;
}

function mapProduct(c: RawCard): StoreProduct | null {
	const name = (c.name ?? "").replace(/\s+/g, " ").trim();
	if (!name || !c.href || c.price == null || c.price <= 0) return null;

	// ⚠️ A rejected size means the pack is UNKNOWN, and unknown is not zero. The product
	// is still returned so the matcher can see it, but with no `pricePer100g` — which is
	// what stops it competing on price. See the header on capsules.
	const size = marketplaceSize(name);
	const packWeightG = size.ok ? size.grams : null;
	const volumetric = size.ok ? !!size.volumetric : false;

	const onSale = c.wasPrice != null && c.wasPrice > c.price;

	return {
		store: "Iherb",
		name,
		priceSgd: c.price,
		packWeightG,
		volumetric,
		unitCount: capsuleCount(name),
		pricePer100g: packWeightG && packWeightG > 0 ? (c.price / packWeightG) * 100 : null,
		dietaryAttributes: [],
		onSale,
		listPriceSgd: onSale ? c.wasPrice : null,
		saleEndsAt: null,
		url: c.href.startsWith("http") ? c.href : `${BASE}${c.href}`,
	};
}

class Iherb implements StoreModule {
	readonly name = "Iherb";

	constructor(private opts: IherbOptions = {}) {}

	async search(term: string): Promise<StoreProduct[]> {
		const url = `${BASE}/search?kw=${encodeURIComponent(term)}`;
		const res = await evaluateInPage(url, EXTRACT, {
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

export const iherb = new Iherb();
export { Iherb };
