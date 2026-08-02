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
function readNextProduct(v) {
  if (!v || !v.name) return null;
  const ssd = (v.storeSpecificData || [])[0] || {};
  const mrp = Number(ssd.mrp);
  const discount = Number(ssd.discount || 0);
  const listed = v.final_price ?? v.finalPrice;
  let price = null;
  if (listed != null && listed !== "") price = Number(listed);
  else if (Number.isFinite(mrp)) price = Number.isFinite(discount) && discount > 0 ? Math.round((mrp - discount) * 100) / 100 : mrp;
  return {
    name: String(v.name),
    brand: String(v.brand?.name || v.brand || ""),
    priceText: price != null && Number.isFinite(price) ? String(price) : "",
    sizeText: String(v.metaData?.DisplayUnit || ""),
    slug: String(v.slug || ""),
  };
}

function fromNextData() {
  const el = document.getElementById("__NEXT_DATA__");
  if (!el) return null;
  let data;
  try { data = JSON.parse(el.textContent); } catch { return null; }

  const urlSlug = decodeURIComponent((location.pathname.split("/product/")[1] || "")).replace(/\/+$/, "");

  // 1. The page's own product sits at layouts[0].value — every recommendation lives under a later layout.
  const own = readNextProduct(data?.props?.pageProps?.product?.data?.page?.layouts?.[0]?.value);
  if (own && (!urlSlug || !own.slug || own.slug === urlSlug)) return own;

  // 2. Path changed? Accept ONLY an object whose slug is the one in the address bar.
  let match = null;
  const walk = (n, depth = 0) => {
    if (!n || typeof n !== "object" || depth > 14 || match) return;
    if (Array.isArray(n)) { for (const v of n) walk(v, depth + 1); return; }
    if (urlSlug && n.slug === urlSlug && n.name) { match = readNextProduct(n); return; }
    for (const v of Object.values(n)) walk(v, depth + 1);
  };
  walk(data);
  // 3. Still nothing → give up and let JSON-LD / the DOM answer. Returning some OTHER product here is the
  //    one outcome worse than returning nothing: it looks filled-in and is silently about the wrong item.
  return match;
}

// ---------------------------------------------------------------------------
// Generic readers
// ---------------------------------------------------------------------------

/**
 * Parse a JSON-LD block, tolerating a MALFORMED one.
 *
 * FairPrice's product JSON-LD ships with an extra closing brace on the end, so `JSON.parse` throws on it —
 * which silently cost us the price on every page where __NEXT_DATA__ was stale (see below). Rather than
 * give up, scan for the first BALANCED top-level object (string-aware, so a brace inside a product
 * description doesn't confuse the count) and parse that.
 */
function parseLooseJson(text) {
  const s = String(text || "");
  try { return JSON.parse(s); } catch { /* fall through to the balanced scan */ }
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
      const price = offer?.price ?? offer?.lowPrice ?? null;
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

/** Product heading — the first sane <h1>, then og:title, then the cleaned <title>. */
function genericName() {
  for (const h of document.querySelectorAll("h1")) {
    const t = (h.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length >= 2 && t.length <= 140) return t;
  }
  const og = document.querySelector('meta[property="og:title"], meta[name="og:title"]')?.content?.trim();
  if (og) return og.split(/\s[|–—]\s/)[0].trim();
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
    const special = fromNextData();
    const ld = jsonLdProduct() || {};
    const name = special?.name || ld.name || genericName();
    sendResponse({
      url: location.href,
      name,
      brand: special?.brand || ld.brand || genericBrand(),
      priceText: special?.priceText || ld.priceText || genericPrice(),
      sizeText: special?.sizeText || ld.sizeText || pageSize(name),
    });
    return false; // responded synchronously
  });
}
