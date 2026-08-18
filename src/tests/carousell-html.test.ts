import { cardSize, parseCards, parseSearchHtml, workerHtmlFetcher } from "../core/stores/carousell.js";
import { check, describe, eq } from "./harness.js";

/**
 * Harvesting Carousell's search page from RAW HTML, with no browser.
 *
 * ⚠️ **This is a scraper against markup nobody promised to keep**, and its class
 * names are already obfuscated hashes (`D_h M_oG …`) that will churn. The anchors
 * it relies on are deliberately the two most stable things on the page — the
 * `/p/<slug>-<id>` href, and the `S$` price as text — because everything else is
 * generated.
 *
 * ⚠️ **The failure that matters is a QUIET one.** A markup change makes this return
 * zero anchors, which reads downstream as "this marketplace has nothing" rather than
 * as a break. `Carousell.search` throws on an empty harvest for exactly that reason;
 * these cases pin the shapes that must keep working.
 */
describe("carousell — harvesting the search page from raw HTML");

/**
 * A cut-down version of the real page, 2026-08-17. Two cards, and every hazard the
 * live markup actually carries: obfuscated classes, the price in a SIBLING of the
 * title rather than inside it, a second anchor sharing one listing's href, a query
 * string on one href, an HTML entity, and a footer after the last card.
 */
const PAGE = `<html><body>
<div class="D_xx M_yy">
<a class="D_a M_b" href="/p/myprotein-impact-whey-natural-strawberry-2-43kg-1454989654">
  <p class="D_h M_oG" style="--max-line:2">Myprotein Impact Whey Protein Natural Strawberry Flavour 2.43kg</p>
  <div class="D_cyC M_cVO"><p class="D_h M_oG" title="S$60">S$60</p></div>
  <p class="D_z M_z">Used</p>
</a>
<a class="badge" href="/p/myprotein-impact-whey-natural-strawberry-2-43kg-1454989654?ref=badge">
  <span>Buyer Protection</span>
</a>
<a class="D_a M_b" href="/p/optimum-nutrition-gold-standard-whey-5lbs-1455780802">
  <p class="D_h M_oG" style="--max-line:2">Optimum Nutrition Gold Standard 100% Whey 5lbs Vanilla &amp; Cream</p>
  <div class="D_cyC M_cVO"><p class="D_h M_oG" title="S$94">S$94</p></div>
  <p class="D_z M_z">New</p>
</a>
</div>
<footer><p>Popular right now: S$1 deals</p></footer>
<script>window.__junk = {"price":"999"};</script>
</body></html>`;

const anchors = parseSearchHtml(PAGE);

eq("harvests one anchor per <a href=/p/…>", anchors.length, 3);
check(
	"strips the query string from the href",
	anchors.every((a) => !a.href.includes("?")),
);
check("keeps the slug and listing id", /\/p\/myprotein-impact-whey.*-1454989654$/.test(anchors[0].href));

// ⚠️ The whole reason the window runs to the NEXT anchor: the price sits in a
// sibling of the title, not inside the title element.
check("captures the price, which lives outside the title element", /S\$60/.test(anchors[0].text));
check("decodes HTML entities", /Vanilla & Cream/.test(anchors[2].text));
check("drops <script> contents", !anchors.some((a) => a.text.includes("__junk")));

describe("carousell — raw HTML is better input than the browser gave");

const cards = parseCards(anchors).filter((c) => c.title && c.price);
eq("two listings survive, the duplicate badge anchor merging into one", cards.length, 2);

const whey = cards.find((c) => c.href.includes("1454989654"))!;
const on = cards.find((c) => c.href.includes("1455780802"))!;

eq("price read from the accumulated text", whey.price, 60);
eq("…and from the second card", on.price, 94);

// ⚠️⚠️ The single most valuable thing this path gains over the CDP harvest. The slug
// writes "2.43kg" as "2-43kg", which `parseCards` turns into "2 43kg" — read as
// **43 kg**, a 17× error in the flattering direction. `cardSize` prefers the card's
// TEXT, where the decimal point survives, and only raw HTML carries it intact.
const size = cardSize(whey);
check("size comes from the text, so the decimal point survives", size.ok);
eq("2.43kg is read as 2430g, NOT 43000g", size.ok ? Math.round(size.grams) : -1, 2430);

// The other half of the same win: the rendered DOM dropped lowercase `s` ("U ed"),
// which made the second-hand badge undetectable. Raw markup does not.
eq("the used badge is readable", whey.condition, "used");
eq("…and so is the new one", on.condition, "new");

describe("carousell — the empty harvest, which must never look like an empty shop");

eq("no anchors at all yields nothing to parse", parseSearchHtml("<html><body>nothing</body></html>").length, 0);
// A page of ONLY badge anchors is the shape a markup change is most likely to
// produce: links still present, cards gone. It must yield no priced cards rather
// than cards with null prices that later read as free.
const badgesOnly = parseSearchHtml(`<a href="/p/x-1"><span>Buyer Protection</span></a>`);
eq("a badge-only anchor yields no priced card", parseCards(badgesOnly).filter((c) => c.price).length, 0);

describe("carousell — a 403 must name the country, not show challenge markup");

/**
 * ⚠️ **The one failure a reader is guaranteed to meet, and it has a switch.**
 * Carousell refuses every country but SG, and `ss-worker` forwards the CALLER's
 * country rather than its own, so a VPN on the laptop is enough to break the
 * whole shop — measured 2026-08-18, Danish exit, 403 on the homepage as well as
 * on /search/. Before this, that surfaced as 300 characters of Cloudflare
 * challenge HTML, which reads like a parser fault and sends the reader to the
 * wrong file.
 */
const CHALLENGE = "<html><head><title>Just a moment...</title></head><body><div id=\"challenge-platform\"></div></body></html>";

const realFetch = globalThis.fetch;
globalThis.fetch = (async () =>
	new Response(CHALLENGE, { status: 403 })) as unknown as typeof globalThis.fetch;
let message = "";
try {
	await workerHtmlFetcher("https://example.invalid/shop", "secret")("https://www.carousell.sg/search/x");
} catch (e: any) {
	message = String(e?.message ?? e);
} finally {
	globalThis.fetch = realFetch;
}
check("a challenge 403 says a VPN is the likely cause", /vpn/i.test(message));
check("…and says the country travels from the CALLER", /caller/i.test(message));
check("…and does not dump the challenge markup instead", !/challenge-platform/.test(message));

/** The contrast: an ordinary non-challenge failure still reports its status and body. */
globalThis.fetch = (async () =>
	new Response("host-not-allowed", { status: 403 })) as unknown as typeof globalThis.fetch;
let plain = "";
try {
	await workerHtmlFetcher("https://example.invalid/shop", "secret")("https://www.carousell.sg/search/x");
} catch (e: any) {
	plain = String(e?.message ?? e);
} finally {
	globalThis.fetch = realFetch;
}
check("a non-challenge 403 keeps its own reason", /host-not-allowed/.test(plain));
