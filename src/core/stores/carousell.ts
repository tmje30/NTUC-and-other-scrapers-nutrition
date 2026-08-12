import type { StoreModule, StoreProduct } from "./types.js";
import { marketplaceSize } from "../marketplace-size.js";
import { evaluateInPage } from "../browser-cdp.js";

/**
 * Carousell — the marketplace tagged on the three whey rows.
 *
 * ⚠️ **This is not a shop and must not be read like one.** Every other store module here
 * reads one seller's own catalogue, where a title and a price are a statement by the
 * company selling it. Here they are free text a stranger typed, and the measured hazards
 * (2026-08-04, one page of 47 whey listings) all err in the *flattering* direction:
 *
 *   - only **62%** state a pack size at all;
 *   - `lbs` dominates, and titles carry ranges ("1.6-5 LBS") and multipacks ("2 X … 2lb");
 *   - **the cheapest listing is usually the scam** — ON Gold Standard 5 lbs appeared at
 *     S$37, S$38 and S$110 in one search against ~S$120 retail.
 *
 * The first two are handled by `marketplaceSize`, which rejects rather than guesses. The
 * third is NOT handled here on purpose: `search()` returns every usable candidate, and
 * choosing between them with `cheapestPlausible` is the caller's job — the scanner knows
 * it is looking at a marketplace, and burying a median-based rejection inside a function
 * called `search` would hide the single most important judgement in this file.
 *
 * Access, measured and unchanged: **search needs a real browser** (Cloudflare serves a
 * shell to plain `fetch`, and headless renders zero cards — it is detected), while a
 * **listing page is plain-fetchable** and carries a JSON-LD `Offer` with price, currency
 * and a machine-readable `itemCondition`. So discovery is expensive and verification is
 * free, which is why only the shortlist gets its page opened.
 */

const BASE = "https://www.carousell.sg";
const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** How many shortlisted listings get their page opened to confirm price and condition. */
const MAX_VERIFY = 8;

/** Politeness between listing fetches. */
const DELAY_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Card scraper, evaluated in the page.
 *
 * ⚠️ **The title comes from the URL SLUG, not from the rendered text, and it has to.**
 * Two things about this page defeat the obvious `innerText` approach, both measured
 * 2026-08-09:
 *
 *  1. **Lowercase `s` is missing from rendered text.** "Used" reads as "U ed",
 *     "MuscleTech" as "Mu cleTech", "Post Workout" as "Po t Workout". Titles read off
 *     the DOM are corrupted in a way that quietly wrecks both size parsing and name
 *     matching — and, worse, makes the second-hand badge undetectable, since `/\bUsed\b/`
 *     can never match "U ed". The slug carries the same words intact.
 *  2. **Several anchors share one listing href** — the card itself plus a "Buyer
 *     Protection" badge. A first-wins dedupe kept whichever came first, which was
 *     usually the badge, so every price came back null and the search returned nothing.
 *     Text is therefore ACCUMULATED per href rather than taken from one anchor.
 *
 * Condition is not read here at all: the listing page's `itemCondition` is authoritative
 * and unobfuscated, and after (1) it is the only trustworthy source anyway.
 */
/**
 * ⚠️ **The page expression harvests and does NOTHING else.** It is a string evaluated in
 * another process, so every regex in it needs double-escaping through a template literal
 * and a syntax error there does not throw — `Runtime.evaluate` simply returns `undefined`
 * and the scan reports "no results", which is indistinguishable from a shop being out of
 * stock. Parsing lives in `parseCards` below instead: same logic, ordinary TypeScript,
 * and unit-testable offline against fixtures.
 */
const EXTRACT = `(() => {
  var out = [];
  var nodes = document.querySelectorAll('a[href*="/p/"]');
  for (var i = 0; i < nodes.length; i++) {
    out.push({
      href: nodes[i].getAttribute('href') || '',
      text: (nodes[i].innerText || '').replace(/\\s+/g, ' ').trim()
    });
  }
  return out;
})()`;

/** One anchor as harvested from the page. */
export interface RawAnchor {
	href: string;
	text: string;
}

export interface Card {
	/** Derived from the URL slug — see `parseCards` for why, not from the card's text. */
	title: string;
	price: number | null;
	href: string;
	/** The card's rendered text, kept for the size and the condition badge. */
	text: string;
	condition: "new" | "used" | "unknown";
}

/**
 * Second-hand or not, read from the card's own badge.
 *
 * ⚠️ **`itemCondition` in the listing's JSON-LD is NOT usable, despite what
 * `docs/vendor-scoping.md` says.** That doc records it as "machine-readable — 'new only'
 * is a deterministic filter, not a title guess", and building on that returned **zero**
 * results: measured 2026-08-09 over the ten cheapest whey listings, **all ten** reported
 * `UsedCondition`, including ones whose card badge plainly read "New". The field appears
 * to be a default rather than a statement, so gating on it rejects the entire shop.
 *
 * The badge does distinguish them, and it survives the missing-`s` obfuscation as long as
 * both spellings are matched — "Used" renders as "U ed".
 */
export function cardCondition(text: string): "new" | "used" | "unknown" {
	// Both spellings: "Used" as written, and "U ed" as this page renders it.
	if (/\bu\s?s?ed\b/i.test(text)) return "used";
	if (/\bnew\b/i.test(text)) return "new";
	return "unknown";
}

/** Badges and the price, which are not part of any product name. */
const NOISE_RE = /\b(buyer protection|free delivery|new|used|u ed|protection)\b|S\$\s?[\d,.]+/gi;

/**
 * ⚠️ **A slug that lost a decimal point is AMBIGUOUS and must never be guessed at.**
 *
 * Carousell's slug replaces `.` with `-`, so "2.5kg" arrives as "2 5kg" once dashes
 * become spaces. Measured 2026-08-09: "myprotein impact whey protein 2 5kg 83 servings"
 * is a **2.5 kg** tub, and reading it off the slug gives **5 kg** — the price per kg then
 * looks half what it is, which is the flattering direction this project keeps having to
 * design against. "2 2kg" (a 2.2 kg tub) reads as 2 kg the same way.
 *
 * There is no way to tell "2 5kg" (2.5 kg) from a genuine "2 5kg" meaning two 5 kg tubs,
 * so the slug is refused for size whenever this shape appears.
 */
const AMBIGUOUS_DECIMAL_RE =
	/\b\d+\s+\d+\s*(kgs?|kg|gms?|grams?|g|mls?|ml|litres?|liters?|ltrs?|ltr|l|lbs?|pounds?|ozs?|oz)\b/i;

/**
 * Put the decimal point back into a slug-derived title, once the true size is known.
 *
 * ⚠️ Cosmetic in the deals list, but NOT cosmetic in `item Name [Vendor n]`: that column
 * exists so a price can be checked against the shelf months later, and a name reading
 * "2 5kg myprotein impact whey protein" invites exactly the misreading the size parser
 * was just fixed to avoid. The repair is only applied when the dotted reading **agrees
 * with the size already parsed from the rendered text**, so it can never invent a number
 * — if the two disagree, the title is left exactly as the slug had it.
 */
export function restoreDecimal(title: string, grams: number): string {
	return title.replace(
		/\b(\d+)\s+(\d+)\s*(kgs?|kg|gms?|grams?|g|mls?|ml|litres?|liters?|ltrs?|ltr|l|lbs?|pounds?|ozs?|oz)\b/gi,
		(whole, a: string, b: string, unit: string) => {
			const dotted = marketplaceSize(`${a}.${b}${unit}`);
			if (!dotted.ok) return whole;
			const agrees = Math.abs(dotted.grams - grams) / Math.max(dotted.grams, grams) < 0.01;
			return agrees ? `${a}.${b}${unit}` : whole;
		},
	);
}

/**
 * The pack size of one card.
 *
 * The RENDERED text is tried first because it is the only place a decimal point survives
 * (the slug drops it — see `AMBIGUOUS_DECIMAL_RE`). Its own defect, the missing lowercase
 * `s`, does not matter for a size: "5LBS" renders as "5LB" and "500g" is untouched, and
 * `marketplaceSize` reads both. The slug is the fallback, and only when it is unambiguous.
 */
export function cardSize(card: Pick<Card, "title" | "text">): ReturnType<typeof marketplaceSize> {
	const cleaned = (card.text ?? "").replace(NOISE_RE, " ").replace(/\s+/g, " ").trim();
	const fromText = marketplaceSize(cleaned);
	if (fromText.ok) return fromText;

	if (AMBIGUOUS_DECIMAL_RE.test(card.title)) {
		return { ok: false, reason: "none" };
	}
	return marketplaceSize(card.title);
}

/**
 * Turn the harvested anchors into one card per listing.
 *
 * ⚠️ **The title comes from the URL SLUG, not the rendered text, and it has to.** Two
 * things about this page defeat the obvious approach, both measured 2026-08-09:
 *
 *  1. **Lowercase `s` is missing from rendered text.** "Used" reads as "U ed",
 *     "MuscleTech" as "Mu cleTech", "Post Workout" as "Po t Workout". A title read off
 *     the DOM is corrupted in a way that quietly wrecks both size parsing and name
 *     matching — and makes the second-hand badge undetectable, since `/\bUsed\b/` can
 *     never match "U ed". The slug carries the same words intact.
 *  2. **Several anchors share one listing href** — the card itself plus a "Buyer
 *     Protection" badge. A first-wins dedupe kept whichever came first, usually the
 *     badge, so every price came back null and the search returned nothing. Text is
 *     therefore ACCUMULATED per href rather than taken from a single anchor.
 *
 * Condition is not read here at all: the listing page's `itemCondition` is authoritative
 * and unobfuscated, and after (1) it is the only trustworthy source anyway.
 */
export function parseCards(anchors: RawAnchor[], limit = 60): Card[] {
	const byHref = new Map<string, string>();
	for (const a of anchors) {
		const href = (a.href || "").split("?")[0];
		if (!href) continue;
		byHref.set(href, `${byHref.get(href) ?? ""} ${a.text ?? ""}`.trim());
	}

	const out: Card[] = [];
	for (const [href, text] of byHref) {
		// The slug is everything after /p/ and before the trailing numeric listing id.
		const m = href.match(/\/p\/(.+?)-(\d+)\/?$/);
		if (!m) continue;
		const pm = text.match(/S\$\s?([\d,]+(?:\.\d+)?)/);
		out.push({
			title: m[1].replace(/-/g, " ").trim(),
			price: pm ? Number(pm[1].replace(/,/g, "")) : null,
			href,
			text,
			condition: cardCondition(text),
		});
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Does this look like a handle Carousell generated, rather than one a person chose?
 *
 * ⚠️ **A free signal, and on the evidence a strong one.** Of the six Gold Standard sellers
 * inspected 2026-08-09, the two in the plausible $85–$88 band had chosen names
 * (`sarah.toys.store`, `gheord`) with 755 and 173 reviews and 12–13 years of history. All
 * four of the suspiciously cheap listings came from three accounts named `liveriver_96a30c`,
 * `nobleowl.3c9a58`, `silentstorm_4bb81d` — Carousell's default `word` + separator + hex —
 * with no reviews and a few months of age.
 *
 * Costs nothing: the username is in the listing's plain HTML, so this runs without the
 * browser the reputation check needs, and can rule a listing out before that is spent.
 *
 * ⚠️ It is a **contributing** signal, never a verdict on its own. A default handle means
 * the account was never personalised, which is ordinary for a genuine one-off seller too;
 * it only withdraws the benefit of the doubt from a price already flagged as too cheap.
 * The hex tail must carry at least two digits, so a chosen name that happens to be
 * hex-legible ("john.beaded") is not mistaken for one.
 */
export function looksAutoGeneratedHandle(handle: string | null | undefined): boolean {
	const h = String(handle ?? "").trim().toLowerCase();
	const m = h.match(/^[a-z]+[._]([0-9a-f]{5,8})$/);
	if (!m) return false;
	return (m[1].match(/\d/g) ?? []).length >= 2;
}

/**
 * The price out of a listing page's JSON-LD `offers` block, or null if it has none.
 *
 * ⚠️ **The comma is part of the number, and dropping it costs a factor of a
 * thousand.** The pattern here used to end `([\d.]+)`, which stops dead at the
 * separator: a listing published as "1,500.00" captured "1", and a $1,500 bike
 * entered the system priced at $1 — finite, positive, and so straight past the
 * guard below to the top of the deals page as the best saving of the day. Carousell
 * writes the grouped form on anything four figures and up, which is most of what is
 * worth scraping there. Same fault as the iHerb weight comma (2026-08-11), and
 * `parseCards` above already read it the right way.
 *
 * Exported for the same reason every other parser in this file is: it is the half
 * that can be wrong without anything failing, and it went unpinned longest precisely
 * because it was buried in the fetch.
 */
export function parseOfferPrice(body: string): number | null {
	const offer = String(body ?? "").match(
		/"offers"\s*:\s*\{[^}]*"price"\s*:\s*"?([\d,]+(?:\.\d+)?)"?[^}]*\}/i,
	);
	if (!offer) return null;
	const price = Number(offer[1].replace(/,/g, ""));
	return Number.isFinite(price) && price > 0 ? price : null;
}

/** A listing page's own JSON-LD offer — the authoritative price and condition. */
async function readListing(
	url: string,
): Promise<{ price: number | null; condition: string; title: string; seller: string } | null> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), 25_000);
	try {
		const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: ctl.signal });
		if (!res.ok) return null;
		const body = await res.text();
		const cond = body.match(/"itemCondition"\s*:\s*"https:\/\/schema\.org\/(\w+)"/i);
		const name = body.match(/<title>([^<]{4,200})<\/title>/i);
		// The seller's handle rides in the page's inline state — free, no browser.
		const seller = body.match(/"username"\s*:\s*"([^"]{2,40})"/);
		return {
			price: parseOfferPrice(body),
			condition: cond?.[1] ?? "",
			title: (name?.[1] ?? "").trim(),
			seller: seller?.[1] ?? "",
		};
	} catch {
		return null;
	} finally {
		clearTimeout(t);
	}
}

/**
 * What a listing page says about the person selling it. Null where it could not be read.
 *
 * ⚠️ **`reviews: 0` and `reviews: null` are different facts and must not be merged.**
 * Zero is the page stating "N/A — No review yet"; null is us failing to read it. Conflating
 * them cost a whole diagnosis on 2026-08-09: a run of listings came back null and was
 * written up as flaky rendering, when the block had rendered perfectly and *said* the
 * seller had no reviews. That is not a missing signal — it is the strongest signal on the
 * page, and it was being discarded.
 */
export interface SellerReputation {
	rating: number | null;
	reviews: number | null;
	/** Whole months on Carousell, when stated. A new account is its own warning. */
	ageMonths: number | null;
}

/**
 * Pull a seller's rating and review count out of a rendered listing page's text.
 *
 * ⚠️ Pure and separate from the fetching for the usual reason — the page is slow, flaky
 * and costs a browser, so the parsing has to be testable without any of that.
 *
 * ⚠️ Both spellings again: the missing lowercase `s` makes "755 reviews" render as
 * "755 review", and "13 years on Carousell" as "13 year on Carou ell". The digits are
 * unaffected, which is why this reads numbers and never words.
 */
export function parseReputation(text: string): SellerReputation {
	const t = (text ?? "").replace(/\s+/g, " ");

	const num = (s: string | undefined): number | null => {
		if (!s) return null;
		const n = Number(s.replace(/,/g, ""));
		return Number.isFinite(n) ? n : null;
	};

	// "4 months on Carousell" — a brand-new account, which is a fact in its own right.
	const age = t.match(/(\d+)\s*(year|month|day)[a-z]*\s*on Carou/i);
	let ageMonths: number | null = null;
	if (age) {
		const n = num(age[1]) ?? 0;
		const unit = age[2].toLowerCase();
		ageMonths = unit === "year" ? n * 12 : unit === "day" ? Math.floor(n / 30) : n;
	}

	// ⚠️ **The case that broke the first version.** A seller with no history renders
	// "N/A — No review yet", which matches no numeric pattern, so it came back as null
	// and read as "could not check" — the most permissive possible reading of the least
	// trustworthy possible seller. It is a STATED zero and is recorded as one.
	if (/no review yet|no reviews yet/i.test(t)) {
		return { rating: null, reviews: 0, ageMonths };
	}

	// The rating badge renders as "5.0 (755)" — rating and its count together.
	const pair = t.match(/(\d(?:\.\d)?)\s*\((\d[\d,]*)\)/);
	// A standalone "755 review(s)" is the fallback when the badge did not render.
	const revs = t.match(/(\d[\d,]*)\s*review/i);

	const rating = pair ? num(pair[1]) : null;
	const reviews = pair ? num(pair[2]) : num(revs?.[1]);
	// A "rating" outside 0–5 is not a rating — it is some other number in parentheses.
	return {
		rating: rating != null && rating >= 0 && rating <= 5 ? rating : null,
		reviews,
		ageMonths,
	};
}

/**
 * Scroll a listing page until the seller block loads, and read its reputation.
 *
 * ⚠️ **This is slow and unreliable, by nature of the page.** The seller block is
 * client-rendered and lazy: measured 2026-08-09, it appeared on one attempt out of
 * roughly six across five listings, even with a 20 s wait — hence the scrolling, and
 * hence `null` being an ordinary result rather than an error. A caller must decide what
 * an unknown reputation means; see `reputationPasses`, which treats it as a refusal.
 *
 * Costs a full browser render per listing, against a plain `fetch` for everything else
 * here, which is why it is only ever asked for a candidate that has already failed the
 * price floor.
 */
export async function sellerReputation(
	listingUrl: string,
	opts: CarousellOptions = {},
): Promise<SellerReputation> {
	// ⚠️ Synchronous and trivial, deliberately. An `async` expression that scrolled and
	// polled was tried repeatedly and kept returning `undefined` from `Runtime.evaluate`
	// — a failure that is indistinguishable from "the seller has no reviews", which is
	// the one answer this function most needs to get right. Whole-text out, parsing in
	// TypeScript, same rule as `EXTRACT` above.
	const EXPR = `(function () {
  return { text: document.body.innerText.replace(/\\s+/g, ' ') };
})()`;
	try {
		const res = await evaluateInPage(listingUrl, EXPR, {
			headed: opts.headed ?? true,
			// The seller block is below the fold and client-rendered; 15 s is what actually
			// produced it in testing, where 9–11 s did not.
			settleMs: opts.settleMs ?? 15_000,
		});
		const v = (res.value ?? {}) as { text?: string };
		return parseReputation(v.text ?? "");
	} catch {
		return { rating: null, reviews: null, ageMonths: null };
	}
}

export interface CarousellOptions {
	/**
	 * ⚠️ Headed by default, and not as a preference: a headless Chrome renders **zero**
	 * cards here — it is detected. Headless is offered only so a caller can prove that
	 * again cheaply rather than taking this comment on trust.
	 */
	headed?: boolean;
	settleMs?: number;
}

export class Carousell implements StoreModule {
	readonly name = "Carousell";

	constructor(private readonly opts: CarousellOptions = {}) {}

	async search(term: string): Promise<StoreProduct[]> {
		const url = `${BASE}/search/${encodeURIComponent(term)}`;
		const res = await evaluateInPage(url, EXTRACT, {
			headed: this.opts.headed ?? true,
			// ⚠️ 7s was measured as NOT enough — the harvest came back empty on runs where
			// the page was fine, which reads downstream as "this shop has nothing".
			settleMs: this.opts.settleMs ?? 12_000,
		});
		const anchors = (res.value as RawAnchor[]) ?? [];
		if (!anchors.length) {
			// Told apart from "this shop has nothing" on purpose: an empty page here means
			// the render or the harvest failed, and reporting that as no stock is how a
			// broken scraper looks healthy for weeks.
			throw new Error(
				"Carousell rendered no listing links — the page did not load, or the harvest expression broke",
			);
		}
		const cards = parseCards(anchors).filter((c) => c.title && c.price);

		// Shortlist BEFORE opening any page: a listing whose title states no usable size
		// can never be compared, so fetching it would buy nothing. This is also what keeps
		// one search to a handful of requests instead of sixty.
		const shortlist: { card: Card; grams: number; volumetric: boolean; per100: number }[] = [];
		for (const c of cards) {
			// Second-hand protein powder is not a substitute for a sealed tub, and the
			// badge is the only trustworthy source for this — see `cardCondition`.
			if (c.condition === "used") continue;
			const size = cardSize(c);
			if (!size.ok) continue;
			const per100 = (c.price! / size.grams) * 100;
			shortlist.push({ card: c, grams: size.grams, volumetric: size.volumetric, per100 });
		}
		// Cheapest first, because those are the ones a buyer would actually consider — and
		// the ones most worth verifying, since that is where the scams are.
		shortlist.sort((a, b) => a.per100 - b.per100);

		const out: StoreProduct[] = [];
		for (const [i, s] of shortlist.slice(0, MAX_VERIFY).entries()) {
			if (i) await sleep(DELAY_MS);
			const listingUrl = `${BASE}${s.card.href}`;
			const listing = await readListing(listingUrl);

			// ⚠️ The listing is fetched to CONFIRM THE PRICE, and for nothing else. Its
			// `itemCondition` is deliberately ignored — see `cardCondition` for the
			// measurement that ruled it out. The price did agree with the card on all ten
			// listings sampled, so this is a cheap consistency check rather than a
			// correction, and a listing that has since been taken down drops out here.
			const price = listing?.price ?? s.card.price!;
			if (!Number.isFinite(price) || price <= 0) continue;

			out.push({
				store: "Carousell",
				name: restoreDecimal(s.card.title, s.grams),
				priceSgd: price,
				packWeightG: s.grams,
				volumetric: s.volumetric,
				unitCount: null,
				pricePer100g: (price / s.grams) * 100,
				dietaryAttributes: [],
				onSale: false,
				listPriceSgd: null,
				saleEndsAt: null,
				url: listingUrl,
				seller: listing?.seller || undefined,
				raw: { card: s.card, listing },
			});
		}
		return out;
	}
}

export const carousell = new Carousell();
