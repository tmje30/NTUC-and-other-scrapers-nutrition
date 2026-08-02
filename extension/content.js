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

/** JSON-LD `Product` structured data — emitted by most modern shop themes. */
function jsonLdProduct() {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse(s.textContent); } catch { continue; }
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
function pageSize(name) {
  for (const hay of [name || "", productContentText()]) {
    const m = hay.match(SIZE_TEXT_RE) || hay.match(COUNT_TEXT_RE);
    if (m) return m[0].trim();
  }
  return "";
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
