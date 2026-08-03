// Content script — extraction ONLY. Never calls Notion (content scripts are CORS-blocked from
// api.notion.com; every Notion call lives in the service worker). Answers the panel's "extract" message
// with whatever it can read off the page. Every field stays editable, so a miss here is a blank box for
// the human, never a wrong silent write.
//
// Reads four things: name, brand, price, and a pack-size string. There is deliberately NO SKU and no ABV —
// the Ingredients DB has no column for either.

// ---------------------------------------------------------------------------
// FairPrice — the one site worth a dedicated reader
// ---------------------------------------------------------------------------
// The scraper already reverse-engineered this page (src/core/stores/fairprice.ts): products live in the
// __NEXT_DATA__ blob, and `metaData.DisplayUnit` is the accurate pack size while `metaData.Weight` is NOT
// ("2 gm" for 2 L of milk). A generic scrape would read the wrong one.
//
// ⚠️ NEVER "find the first product-shaped object" in this blob. A FairPrice product page embeds its whole
// recommendations carousel in the SAME payload — on the Vegeponics Crystal Lettuce page there are 17
// product objects and the page's OWN product is not among them, because only the carousel entries carry
// `final_price`. An earlier version of this function took the first one and captured "ZENXIN Organic
// Crystal Lettuce $3.65/200 G" while the user was looking at "Vegeponics … $2.80/120 G". Everything below
// is anchored on the URL slug so that cannot recur.
//
// The page's own product also prices differently from a search result: it has no `final_price`, and its
// selling price is storeSpecificData[0] `mrp` MINUS `discount` (measured: Simply Organic Cinnamon,
// mrp 11.9 − discount 0.59 = the $11.31 on the page).
//
// ⚠️ __NEXT_DATA__ GOES STALE. It reflects the page Next.js first loaded, and an in-site navigation does not
// rewrite it. Browsing Yoghurt → a product leaves the CATEGORY page's blob in the DOM with no `product` key
// at all, while the address bar shows the product. Verified in a real browser. That is why the slug check
// below exists and why JSON-LD is a first-class fallback rather than a nicety — on a page reached by
// clicking, JSON-LD is the only current structured data there is.
/**
 * Money to 2 dp. Needed on EVERY price path, not just arithmetic we do ourselves: FairPrice's own
 * `final_price` field ships binary-float artefacts straight out of the API ("7.949999999999999",
 * "5.869999999999999"), which used to land in the form verbatim.
 */
function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
}

function readNextProduct(v) {
  if (!v || !v.name) return null;
  const ssd = (v.storeSpecificData || [])[0] || {};
  const mrp = Number(ssd.mrp);
  const discount = Number(ssd.discount || 0);
  const listed = v.final_price ?? v.finalPrice;
  let price = null;
  if (listed != null && listed !== "") price = money(listed);
  else if (Number.isFinite(mrp)) price = money(Number.isFinite(discount) && discount > 0 ? mrp - discount : mrp);
  return {
    name: String(v.name),
    brand: String(v.brand?.name || v.brand || ""),
    priceText: price != null ? String(price) : "",
    sizeText: String(v.metaData?.DisplayUnit || ""),
    slug: String(v.slug || ""),
  };
}

const urlSlugOf = () => decodeURIComponent((location.pathname.split("/product/")[1] || "")).replace(/\/+$/, "");

/** The product THIS page is showing, out of one parsed __NEXT_DATA__ blob. Null if it isn't in there. */
function productFromBlob(data, urlSlug) {
  // The page's own product sits at layouts[0].value — every recommendation lives under a later layout.
  const own = readNextProduct(data?.props?.pageProps?.product?.data?.page?.layouts?.[0]?.value);
  if (own && (!urlSlug || !own.slug || own.slug === urlSlug)) return own;

  // Path changed? Accept ONLY an object whose slug is the one in the address bar.
  let match = null;
  const walk = (n, depth = 0) => {
    if (!n || typeof n !== "object" || depth > 14 || match) return;
    if (Array.isArray(n)) { for (const v of n) walk(v, depth + 1); return; }
    if (urlSlug && n.slug === urlSlug && n.name) { match = readNextProduct(n); return; }
    for (const v of Object.values(n)) walk(v, depth + 1);
  };
  walk(data);
  // Otherwise give up. Returning some OTHER product is the one outcome worse than returning nothing: it
  // looks filled in and is silently about the wrong item.
  return match;
}

const NEXT_BLOB_RE = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/;

/**
 * The page's product from __NEXT_DATA__ — re-fetching the page itself when the inline copy has gone stale.
 *
 * WHY THIS EXISTS. Measured over 40 FairPrice product pages: the server-rendered __NEXT_DATA__ was valid
 * JSON, matched the URL slug and carried a price on 40/40. The product JSON-LD was invalid on 40/40. So the
 * reliable source is this one — its ONLY weakness is that the inline copy is not rewritten on an in-site
 * navigation, which is exactly when we were falling back to the broken one.
 *
 * A content script is same-origin with its page, so it can simply ask the server again. Measured in a real
 * browser from a stale page: HTTP 200 in ~480 ms, valid JSON, slug matched. One extra request, only on a
 * page reached by clicking, and never for a directly-opened page (the inline copy is correct there).
 */
async function fromNextData() {
  const el = document.getElementById("__NEXT_DATA__");
  if (!el) return null; // not a Next.js page — nothing to read or re-fetch
  const urlSlug = urlSlugOf();

  try {
    const inline = productFromBlob(JSON.parse(el.textContent), urlSlug);
    if (inline) return inline;
  } catch { /* unparseable inline blob — the re-fetch below is the answer to that too */ }

  if (!urlSlug) return null; // not a product page; nothing to re-fetch for
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000); // never hang the panel on a slow network
    const res = await fetch(location.href, { credentials: "same-origin", signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const m = NEXT_BLOB_RE.exec(await res.text());
    return m ? productFromBlob(JSON.parse(m[1]), urlSlug) : null;
  } catch {
    return null; // offline / aborted / blocked → fall through to JSON-LD and the DOM
  }
}

// ---------------------------------------------------------------------------
// Generic readers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON-LD block, tolerating a MALFORMED one.
 *
 * FairPrice's product JSON-LD is invalid JSON in at least TWO different ways, and each one silently cost us
 * the price on every page where __NEXT_DATA__ had gone stale:
 *
 *   1. a stray closing brace on the end        (Meiji Low Fat Yoghurt)
 *   2. RAW newlines inside a string value      (Tamar Valley — the `description` carries the importer's
 *      postal address across several lines: "Kaiser Foods Singapore Pte Ltd, ⏎103 Kallang Avenue …")
 *
 * So the parse is a repair ladder rather than a single attempt. Both repairs are string-aware, and neither
 * touches an already-valid block: a plain `JSON.parse` is always tried first.
 */

/** Escape control characters that appear INSIDE a string literal — illegal in JSON, common in the wild. */
function escapeControlsInStrings(s) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { out += c; esc = false; continue; }
      if (c === "\\") { out += c; esc = true; continue; }
      if (c === '"') { out += c; inStr = false; continue; }
      const code = c.charCodeAt(0);
      if (code < 32) { out += code === 10 ? "\\n" : code === 13 ? "\\r" : code === 9 ? "\\t" : " "; continue; }
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  return out;
}

/** The first BALANCED top-level object. String-aware, so a brace inside a description can't miscount. */
function firstBalancedObject(s) {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function parseLooseJson(text) {
  const raw = String(text || "");
  for (const s of [raw, escapeControlsInStrings(raw)]) {
    try { return JSON.parse(s); } catch { /* try the next repair */ }
    const obj = firstBalancedObject(s);
    if (obj) return obj;
  }
  return null;
}

/** JSON-LD `Product` structured data — emitted by most modern shop themes. */
function jsonLdProduct() {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    const data = parseLooseJson(s.textContent);
    if (!data) continue;
    const nodes = [];
    const walk = (n) => {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) return n.forEach(walk);
      nodes.push(n);
      if (n["@graph"]) walk(n["@graph"]);
    };
    walk(data);
    for (const n of nodes) {
      const t = n["@type"];
      if (!(t === "Product" || (Array.isArray(t) && t.includes("Product")))) continue;
      const offer = Array.isArray(n.offers) ? n.offers[0] : n.offers;
      const price = money(offer?.price ?? offer?.lowPrice ?? null);
      // Identity check, for the same reason the __NEXT_DATA__ reader has one: after an in-site navigation a
      // page can still be carrying the PREVIOUS product's structured data. When the block names a URL, it
      // must be this page's. Blocks that name no URL are accepted — most shops' JSON-LD omits it.
      const declared = offer?.url || n["@id"] || n.url || "";
      if (declared && !sameProductUrl(declared, location.href)) continue;
      return {
        name: n.name || "",
        brand: typeof n.brand === "string" ? n.brand : n.brand?.name || "",
        priceText: price != null ? String(price) : "",
        sizeText: n.weight?.value ? `${n.weight.value} ${n.weight.unitCode || ""}`.trim() : "",
      };
    }
  }
  return null;
}

/** Same product page? Compares host + path only, ignoring query, hash and a trailing slash. */
function sameProductUrl(a, b) {
  try {
    const ua = new URL(a, location.href), ub = new URL(b, location.href);
    const norm = (u) => `${u.host.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
    return norm(ua) === norm(ub);
  } catch { return false; }
}

/**
 * The PRODUCT's own content region, for the size scan. Deliberately SCOPED to the main product containers
 * and NOT document.body, so a related-products carousel's stray "500 g" is never read as this item's size.
 */
const CONTENT_SELECTORS = [
  ".entry-summary", ".summary", ".product-details", ".product-info", ".product-description",
  ".product__description", ".product-single__description", '[itemprop="description"]',
  "[class*='ProductDetail']", "[class*='product-detail']",
];
function productContentText() {
  const parts = [];
  const seen = new Set();
  for (const sq of CONTENT_SELECTORS) {
    for (const el of document.querySelectorAll(sq)) {
      if (seen.has(el)) continue;
      seen.add(el);
      const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    }
  }
  return parts.join(" • ").slice(0, 4000);
}

/** A pack size from the product NAME first (most SG grocers put it there), else the scoped content. */
const SIZE_TEXT_RE = /(\d+(?:[.,]\d+)?)\s*(?:x\s*\d+(?:[.,]\d+)?\s*)?(kg|kgs|g|gm|gms|gram|grams|ml|cl|dl|l|ltr|litre|liter)\b/i;
const COUNT_TEXT_RE = /\(\s*\d+\s*(?:s|pc|pcs|piece|pieces)?\s*\)|\b\d+\s*(?:pcs|pieces)\b/i;

/**
 * A leaf element whose ENTIRE text is a size ("135g", "1.5 kg", "200 G").
 *
 * This is how FairPrice prints the pack size next to the product title, and it is the only size reading
 * available once __NEXT_DATA__ has gone stale. Requiring the element to contain nothing BUT the size is
 * what makes it safe: a "$60 min. spend" banner or a "500g" in a description paragraph never matches,
 * because those elements carry other words too. Measured on the Meiji yoghurt page: exactly one hit.
 */
const SIZE_ONLY_RE = /^\d+(?:[.,]\d+)?\s*(?:kg|kgs|g|gm|gms|gram|grams|ml|cl|dl|l|ltr|litre|liter)$/i;
function leafSize() {
  for (const el of document.querySelectorAll("span,div,p,li,td,dd,strong,em,small")) {
    if (el.children.length) continue; // leaf nodes only
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length <= 12 && SIZE_ONLY_RE.test(t)) return t;
  }
  return "";
}

function pageSize(name) {
  for (const hay of [name || "", productContentText()]) {
    const m = hay.match(SIZE_TEXT_RE) || hay.match(COUNT_TEXT_RE);
    if (m) return m[0].trim();
  }
  return leafSize();
}

/** Product heading — the first sane <h1>, then og:title. Both name THIS product, so both are trusted. */
function headingName() {
  for (const h of document.querySelectorAll("h1")) {
    const t = (h.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length >= 2 && t.length <= 140) return t;
  }
  const og = document.querySelector('meta[property="og:title"], meta[name="og:title"]')?.content?.trim();
  return og ? og.split(/\s[|–—]\s/)[0].trim() : "";
}

/**
 * The tab title — the LAST resort, and a bad one on an app-rendered shop.
 *
 * Sheng Siong serves every page the same site-wide title ("Online Grocery Shopping and Delivery @ Sheng
 * Siong Online Singapore"), so this would confidently fill the Name box with the shop's slogan. Used only
 * when something else on the page corroborated that we're really looking at a product (a price or a size).
 */
function titleName() {
  return (document.title || "").split(/\s[|–—-]\s/)[0].trim();
}

/**
 * Price is the ambiguous field — a page has many numbers (sale/regular, related items, "free delivery over
 * $60") — so only STRUCTURED, single-value sources are read: the product-price meta, an itemprop="price",
 * then a price element scoped to the product summary. "" when none is certain; the user types it.
 */
function genericPrice() {
  const meta = document.querySelector('meta[property="product:price:amount"], meta[name="product:price:amount"], meta[itemprop="price"]')?.content?.trim();
  if (meta) return meta;
  const ip = document.querySelector('[itemprop="price"]');
  if (ip) { const v = (ip.getAttribute("content") || ip.textContent || "").trim(); if (v) return v; }
  const el = document.querySelector(".summary .price, .product-details .price, [class*='ProductPrice'], [class*='product-price']");
  if (el) { const t = (el.textContent || "").replace(/\s+/g, " ").trim(); if (t) return t; }
  return "";
}

/** Brand from structured metadata, when the page states one separately from the title. */
function genericBrand() {
  const meta = document.querySelector('meta[property="product:brand"], meta[name="product:brand"]')?.content?.trim();
  if (meta) return meta;
  const ib = document.querySelector('[itemprop="brand"]');
  if (ib) return (ib.getAttribute("content") || ib.textContent || "").trim();
  return "";
}

// Injected ON DEMAND (chrome.scripting.executeScript), not via manifest content_scripts, so it must run on
// any site. Re-opening the extension re-injects it; guard so the listener is registered only once per page
// (a second listener would answer the same "extract" twice).
if (!window.__ingredientAddExtractorReady) {
  window.__ingredientAddExtractorReady = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "extract") return false;
    // Async now: fromNextData() may re-fetch the page when the inline blob is stale. `return true` keeps
    // the message channel open until sendResponse fires — without it Chrome closes it and the caller sees
    // an empty reply. A failure still answers, with blank fields, rather than leaving the panel spinning.
    (async () => {
      let special = null;
      try { special = await fromNextData(); } catch { /* fall through to JSON-LD / DOM */ }
      const ld = jsonLdProduct() || {};
      const trusted = special?.name || ld.name || headingName();
      const priceText = special?.priceText || ld.priceText || genericPrice();
      const sizeText = special?.sizeText || ld.sizeText || pageSize(trusted);
      // Fall back to the tab title ONLY when a price or size corroborates that this is a product page —
      // otherwise a site-wide title becomes a confident-looking wrong name. Blank is the honest answer.
      const name = trusted || (priceText || sizeText ? titleName() : "");
      sendResponse({ url: location.href, name, brand: special?.brand || ld.brand || genericBrand(), priceText, sizeText });
    })();
    return true; // async sendResponse
  });
}
