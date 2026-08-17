import { evaluate } from "./match.js";
import { queryTerms } from "./run.js";
import { targetFor } from "./vendor-scan.js";
import { cheapestPlausible } from "./marketplace-size.js";
import { PAGE_CSS } from "./page-chrome.js";
import type { StoreModule, StoreProduct } from "./stores/types.js";
import { fairprice } from "./stores/fairprice.js";
import { shengsiong } from "./stores/shengsiong.js";
import { guardian } from "./stores/guardian.js";
import { myprotein } from "./stores/myprotein.js";
import { carousell } from "./stores/carousell.js";
import { shengsiongViaWorker } from "./stores/shengsiong-worker.js";
import type { ParsedItem } from "./list-parse.js";
import { sizeLabel } from "./list-parse.js";

/**
 * Pricing an item the user has never had in Notion.
 *
 * The daily deals pipeline cannot answer this question. Every card it renders is
 * "cheaper than the price you already record" — `readGroceryTargets()` drops a
 * row with no baseline, and `findDeal` needs one to compute a percentage. A
 * texted item like "harissa paste" has no baseline by definition, so there is
 * nothing to be a percentage OF.
 *
 * ⚠️ **So a new-item card is deliberately a different claim from a deal card**,
 * and the difference is the honest part. It shows what each shop charges and
 * which is cheapest per kg/L; the red `−%` appears only where the SHOP itself
 * flags a sale against its own list price, which is a real number nobody had to
 * invent. There is no "vs your price" row, because there is no your-price.
 *
 * ⚠️ **The page carries no Buy / Add / Replace buttons, and that is not an
 * omission.** Every one of those writes through an `AddPayload`, which requires
 * an `ingredientId` — the id of an EXISTING Ingredients page (see
 * `grocery-list.ts`). A new item has none, and the fix would be to make that
 * field optional across a live write path so a button could create rows from
 * thin air. The texted item is already on the grocery list by the time this page
 * exists — the bot put it there — so the page's job is just to say where to buy it.
 */

const esc = (s: string) =>
	String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The shops a new item is searched at, and whether each is a marketplace.
 *
 * ⚠️ **Five shops, not the daily scan's two.** `run.ts`'s `STORES` is the deals
 * pipeline's list; the other three (Guardian, MyProtein, Carousell) are only
 * reached by `vendor-scan.ts`, which asks a shop **only when an Ingredients row
 * names it in `Vendor 1..4`**. A brand-new item has no row, so under that rule it
 * would never be searched anywhere but the two supermarkets — which is precisely
 * backwards, since an item you have no row for is the one you least know where to
 * buy. The directed-search rule exists to stop an automated scan writing a price
 * into a slot the user didn't ask for; nothing here writes to Notion at all, so it
 * doesn't apply.
 *
 * ⚠️ **Sheng Siong must be a LIVE search here, never `shengsiong-file`.** The file
 * reader answers only the terms in that day's committed scan, so a new item's term
 * is never in it and Sheng Siong would contribute **zero results, silently, every
 * time** — no error, just a shop quietly missing from every new-item card.
 *
 * ⚠️ **Which live module depends on WHERE this runs, and getting it wrong is the
 * same silent zero.** `stores/shengsiong.ts` speaks DDP from this machine and works
 * only from Singapore; from a US GitHub runner it is challenged on every search. Use
 * `NEW_ITEM_SHOPS` on the laptop and `CLOUD_NEW_ITEM_SHOPS` in Actions — the latter
 * swaps in `shengsiong-worker.ts`, which borrows `ss-worker`'s Singapore placement.
 */
export interface ShopRoute {
	module: StoreModule;
	/**
	 * True where the cheapest listing is usually the scam and the pick must come
	 * from `cheapestPlausible` rather than from the minimum.
	 */
	marketplace: boolean;
}

export const NEW_ITEM_SHOPS: ShopRoute[] = [
	{ module: fairprice, marketplace: false },
	{ module: shengsiong, marketplace: false },
	{ module: guardian, marketplace: false },
	{ module: myprotein, marketplace: false },
	{ module: carousell, marketplace: true },
];

/**
 * The same shops, as reachable from **GitHub Actions** — a US-hosted runner.
 *
 * Measured 2026-08-16/17 from a real runner, not assumed:
 *
 * | shop | from a US runner | route here |
 * | --- | --- | --- |
 * | FairPrice | ✅ works (runs there daily already) | direct |
 * | Guardian | ✅ 30 products, 22 sized | direct |
 * | MyProtein | ✅ 10 products, 10 sized | direct |
 * | Sheng Siong | ❌ challenged — it answers Singapore only | **via `ss-worker`** |
 * | Carousell | ❌ **403 on every path**, listing pages included | *omitted — see below* |
 *
 * ⚠️ **Carousell is deliberately absent, and its absence is the honest option of
 * two bad ones.** It 403s a US address outright, so including it would add a
 * guaranteed error to every single card. It is not blocked from Singapore and needs
 * no browser there (measured: a plain `fetch` from a Worker returns the search page
 * whole, 47 listings) — but harvesting it that way needs an HTML parser written
 * against obfuscated class names, which is its own piece of work and its own risk.
 * Until that exists, cloud-priced cards compare four shops.
 *
 * ⚠️ **Four shops is a REAL reduction, not a technicality**, and the page must not
 * imply otherwise: Carousell is the only marketplace here, so its absence removes
 * the second-hand price point entirely. `renderNewItemsPage` reads the offers it is
 * given and says nothing about shops that were never asked — which is why the
 * omission is recorded here, loudly, rather than in a commit message nobody reads.
 */
export const CLOUD_NEW_ITEM_SHOPS: ShopRoute[] = [
	{ module: fairprice, marketplace: false },
	{ module: shengsiongViaWorker, marketplace: false },
	{ module: guardian, marketplace: false },
	{ module: myprotein, marketplace: false },
];

/** One shop's best plausible listing for a typed item. */
export interface NewItemOffer {
	store: string;
	name: string;
	brand?: string;
	priceSgd: number;
	packWeightG: number | null;
	unitCount: number | null;
	volumetric: boolean;
	pricePer100g: number | null;
	onSale: boolean;
	listPriceSgd: number | null;
	url: string;
	/** From a marketplace — the page says so, because the price is not a shop's. */
	marketplace?: boolean;
}

/** Everything found for one typed item. */
export interface NewItemResult {
	/** The name as typed, which is also what was searched. */
	query: string;
	/** How many the user asked for, carried through for the page's own line. */
	count: number;
	/** Pack size the user stated, if any — "500g". */
	size?: string;
	/** Best listing per shop, cheapest per kg/L first. Empty when nothing matched. */
	offers: NewItemOffer[];
	errors: { store: string; message: string }[];
}

/** The committed hand-off file, same shape convention as `shengsiong-latest.json`. */
export interface NewItemsFile {
	/** SGT date the scan ran. A stale file is ignored rather than published. */
	date: string;
	generatedAt: string;
	/** `laptop` or `phone` — from RUNNER_SOURCE, like the Sheng Siong runner. */
	source: string;
	results: NewItemResult[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toOffer(p: StoreProduct, marketplace: boolean): NewItemOffer {
	return {
		store: p.store,
		name: p.name,
		brand: p.brand,
		priceSgd: p.priceSgd,
		packWeightG: p.packWeightG,
		unitCount: p.unitCount,
		volumetric: p.volumetric,
		pricePer100g: p.pricePer100g,
		onSale: p.onSale,
		listPriceSgd: p.listPriceSgd,
		url: p.url,
		marketplace: marketplace || undefined,
	};
}

/**
 * Rank two listings from the same shop. Per-100g wins where both have it — that
 * is the comparison that survives different pack sizes. Where one side has no
 * weight, fall back to the whole-pack price rather than dropping the listing:
 * a shop that publishes no weight is common, and "no answer" is worse than
 * "cheapest pack".
 */
function cheaper(a: NewItemOffer, b: NewItemOffer): NewItemOffer {
	if (a.pricePer100g && b.pricePer100g) return a.pricePer100g <= b.pricePer100g ? a : b;
	if (a.pricePer100g && !b.pricePer100g) return a;
	if (b.pricePer100g && !a.pricePer100g) return b;
	return a.priceSgd <= b.priceSgd ? a : b;
}

/** Sort key across shops: per kg/L where known, whole pack otherwise (after). */
function rank(o: NewItemOffer): number {
	return o.pricePer100g ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Search every shop for one typed item and keep the best plausible listing per shop.
 *
 * "Plausible" is `evaluate()`'s ACCEPT band — the same matcher, thresholds,
 * synonyms and penalties the daily scan uses. Reusing it matters more here than
 * anywhere: there is no baseline to sanity-check the answer against, so a
 * mismatched product is not a bad deal, it is simply a wrong price for a thing
 * the user never asked about.
 */
export async function scanNewItem(
	item: ParsedItem,
	shops: ShopRoute[] = NEW_ITEM_SHOPS,
): Promise<NewItemResult> {
	// A target with no baseline. `targetFor` already handles that case — it drops
	// the `Quality item` gate, which against a baseline of zero would reject
	// everything and look exactly like a shop being out of stock.
	const target = targetFor({
		pageId: "",
		name: item.name,
		unitType: item.volumetric ? "By ml" : "By Gram",
		tags: [],
		baseline: { priceSgd: null, size: null },
	});

	const errors: NewItemResult["errors"] = [];
	// Every accepted candidate is collected per shop and only reduced at the end,
	// because a marketplace cannot be reduced pairwise: `cheapestPlausible` takes a
	// median over the whole field, and a running "cheapest so far" would have
	// already thrown away the listings that define what normal looks like.
	const found = new Map<string, { route: ShopRoute; products: StoreProduct[] }>();
	const seen = new Set<string>();

	for (const shop of shops) {
		for (const term of queryTerms(target.search.searchTerm, target.search.properties)) {
			try {
				for (const p of await shop.module.search(term)) {
					const key = `${p.store}|${p.url || p.name}`;
					if (seen.has(key)) continue;
					seen.add(key);
					if (evaluate(target, p).verdict !== "accept") continue;
					const bucket = found.get(p.store) ?? { route: shop, products: [] };
					bucket.products.push(p);
					found.set(p.store, bucket);
				}
			} catch (e: any) {
				errors.push({ store: shop.module.name, message: e.message });
			}
		}
		await sleep(400); // be polite between store calls, as `run.ts` does
	}

	const offers: NewItemOffer[] = [];
	for (const { route, products } of found.values()) {
		const best = route.marketplace ? bestFromMarketplace(products) : bestFromShop(products);
		if (best) offers.push(toOffer(best, route.marketplace));
	}

	return {
		query: item.name,
		count: item.count,
		size: sizeLabel(item),
		offers: offers.sort((a, b) => rank(a) - rank(b)),
		errors,
	};
}

/** An ordinary shop: the cheapest listing is simply the cheapest listing. */
function bestFromShop(products: StoreProduct[]): StoreProduct | null {
	let best: NewItemOffer | null = null;
	let bestProduct: StoreProduct | null = null;
	for (const p of products) {
		const offer = toOffer(p, false);
		if (!best || cheaper(best, offer) === offer) {
			best = offer;
			bestProduct = p;
		}
	}
	return bestProduct;
}

/**
 * A marketplace: the minimum is usually the scam, so the pick is the cheapest
 * listing that isn't implausibly below the median of the field
 * (`cheapestPlausible`, the same guard `vendor-scan.ts` uses for Carousell).
 *
 * ⚠️ **An unpriced marketplace listing is dropped, not kept as a fallback.** The
 * whole-pack fallback that a real shop gets does not apply here: without a
 * readable size there is nothing to take a median over, so the plausibility guard
 * cannot run at all — and an unguarded Carousell price sitting next to an NTUC one
 * is exactly the comparison this is trying not to publish.
 *
 * ⚠️ The `reference` floor in `vendor-scan.ts`'s version is deliberately absent:
 * it checks a candidate against the price the user already records, and a new item
 * has none. The median guard is the only one available here, which is a reason to
 * label the offer as a marketplace on the page rather than to trust it silently.
 */
function bestFromMarketplace(products: StoreProduct[]): StoreProduct | null {
	const priced = products
		.filter((p) => p.pricePer100g != null && p.pricePer100g > 0)
		.map((p) => ({ p, pricePer100g: p.pricePer100g! }));
	if (!priced.length) return null;
	return cheapestPlausible(priced).pick?.p ?? null;
}

/**
 * Scan a batch, sequentially — the shops are rate-limited, not the caller.
 *
 * Closes the Sheng Siong DDP socket at the end. The poller is a long-running
 * process, so an unclosed websocket per batch would accumulate; `search()` calls
 * `ensureConnected()` and reconnects on its own next time.
 */
export async function scanNewItems(
	items: ParsedItem[],
	shops: ShopRoute[] = NEW_ITEM_SHOPS,
): Promise<NewItemResult[]> {
	const out: NewItemResult[] = [];
	try {
		for (const item of items) out.push(await scanNewItem(item, shops));
	} finally {
		try {
			shengsiong.close();
		} catch {
			/* already closed, or never opened — not worth failing a scan over */
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const bigUnit = (volumetric: boolean) => (volumetric ? "L" : "kg");

function packLabel(n: number, volumetric: boolean): string {
	const big = volumetric ? "L" : "kg";
	const small = volumetric ? "ml" : "g";
	return n >= 1000 ? `${+(n / 1000).toFixed(2)}${big}` : `${Math.round(n)}${small}`;
}

/** `$11.30/kg`, or `$0.185 each` for a counted pack with no weight. */
function unitPrice(o: NewItemOffer): string {
	if (o.pricePer100g) return `$${(o.pricePer100g * 10).toFixed(2)}/${bigUnit(o.volumetric)}`;
	if (o.unitCount && o.unitCount > 0) return `$${(o.priceSgd / o.unitCount).toFixed(3)} each`;
	return "";
}

/** The shop's own discount off its own list price. Null when it isn't on sale. */
function salePct(o: NewItemOffer): number | null {
	if (!o.onSale || !o.listPriceSgd || o.listPriceSgd <= 0) return null;
	return Math.round(((o.listPriceSgd - o.priceSgd) / o.listPriceSgd) * 100);
}

function offerRow(o: NewItemOffer, cheapest: boolean): string {
	const pack = o.packWeightG
		? `<span class="pack">[${packLabel(o.packWeightG, o.volumetric)}]</span> `
		: o.unitCount
			? `<span class="pack">[${o.unitCount} pcs]</span> `
			: "";
	const pct = salePct(o);
	const sale = pct != null ? ` <span class="sale">🔻 on sale (−${pct}%)</span>` : "";
	const per = unitPrice(o);
	// The cheapest row is marked rather than being the only one shown: seeing that
	// two shops are 30 cents apart is the point of putting them side by side.
	const flag = cheapest ? ` <span class="sale">← cheapest</span>` : "";
	// ⚠️ A marketplace price is labelled, always. It is a stranger's listing, not a
	// shop's shelf price, and it survived only a median-plausibility guard — with no
	// recorded price for this item there was nothing stronger to check it against.
	// Unlabelled beside an NTUC price it reads as the same kind of number.
	const via = o.marketplace ? ` <span class="pack">[marketplace listing]</span>` : "";
	return `
          <div class="meta"><span class="store">${esc(o.store)}</span> · ${esc(o.name)}${via}</div>
          <div class="meta">${pack}<span class="prodprice">$${o.priceSgd.toFixed(2)}</span>${sale}</div>
          <div class="price"><b>${per || "—"}</b>${flag}</div>`;
}

function itemCard(r: NewItemResult): string {
	const want = [r.count > 1 ? `×${r.count}` : "", r.size ? `[${esc(r.size)}]` : ""]
		.filter(Boolean)
		.join(" ");
	const head = `<div class="row1"><span class="name">${esc(r.query)}</span>${
		want ? ` <span class="pack">${want}</span>` : ""
	}</div>`;

	if (!r.offers.length) {
		const why = r.errors.length
			? `no shop answered — ${esc(r.errors.map((e) => e.store).join(", "))} failed`
			: "no confident match in either shop";
		return `
    <div class="card">
      <div class="main">
        <div class="body">
          ${head}
          <div class="usage">${why}</div>
        </div>
      </div>
    </div>`;
	}

	// The badge is the SHOP's discount, never a saving against the user's own
	// price — a new item has no price of the user's to save against.
	const top = r.offers[0];
	const pct = salePct(top);
	const rail = pct != null ? `<div class="rail"><span class="pct">−${pct}%</span></div>` : "";
	const rows = r.offers
		.map((o, i) => offerRow(o, r.offers.length > 1 && i === 0 && Boolean(o.pricePer100g)))
		.join("");
	const first = r.offers[0];
	const link = first.url
		? `<a class="body" href="${esc(first.url)}" target="_blank" rel="noopener">`
		: `<div class="body">`;
	const close = first.url ? "</a>" : "</div>";

	return `
    <div class="card">
      <div class="main">
        ${rail}
        ${link}
          ${head}
          ${rows}
        ${close}
      </div>
    </div>`;
}

/**
 * The new-items page. Same stylesheet as the deals and history pages
 * (`page-chrome.ts`), so a link from one to the other doesn't look like a
 * different site — that shared chrome is why the two existing pages can't drift
 * apart visually, and this is the third.
 */
export function renderNewItemsPage(results: NewItemResult[], generatedAt = new Date()): string {
	const date = generatedAt.toLocaleDateString("en-SG", {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		timeZone: "Asia/Singapore",
	});
	const found = results.filter((r) => r.offers.length).length;

	return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>New items · prices</title>
${PAGE_CSS}
</head><body>
<div class="wrap">
  <h1>🆕 New items</h1>
  <p class="sub">${date} · ${found} of ${results.length} priced</p>
  <p class="sub">These aren't in your Ingredients DB yet, so there's no price of
  yours to compare against. Shown: what each shop charges, cheapest per kg/L
  first. A <span class="sale">−%</span> is the shop's own discount.</p>
  ${results.map(itemCard).join("")}
  <p class="sub"><a href="./">← deals page</a> · <a href="./history.html">history</a></p>
</div>
</body></html>`;
}
