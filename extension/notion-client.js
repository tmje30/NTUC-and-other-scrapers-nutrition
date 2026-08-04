// The ONE module that talks to Notion. Runs ONLY in the background service worker: content scripts are
// CORS-blocked from api.notion.com; extension pages/workers are exempt via host_permissions.
//
// Shares the project's source of truth instead of copying it:
//   - the data-source id + exact property names come from ../src/core/ingredients-schema.ts
//   - name similarity uses the scraper's own score() from ../src/core/match.ts
//
// ⚠️ API version 2025-09-03, the same one @notionhq/client v5 sends. That dialect queries DATA SOURCES,
// not databases (`/v1/data_sources/{id}/query`), and a created page's parent is `data_source_id`. The
// reference extension this is modelled on speaks 2022-06-28 — do not copy its endpoints across.
import { INGREDIENTS_DS, ING_MACRO_PROPS, ING_PROPS, REQUIRED_ING_PROPS } from "../src/core/ingredients-schema.js";
import { score, REVIEW_THRESHOLD } from "../src/core/match.js";

const VERSION = "2025-09-03";

async function getToken() {
  const { notionToken } = await chrome.storage.local.get("notionToken");
  return (notionToken || "").trim();
}

async function api(path, { method = "GET", body } = {}) {
  const token = await getToken();
  if (!token) throw new Error("No Notion token configured — open the extension Options page.");
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(`https://api.notion.com/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 600 * attempt));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Notion ${method} ${path} -> ${res.status}`);
      await new Promise((r) => setTimeout(r, 600 * attempt));
      continue;
    }
    const json = await res.json();
    if (!res.ok) throw new Error(`Notion ${method} ${path} -> ${res.status}: ${json.message || JSON.stringify(json)}`);
    return json;
  }
  throw lastErr;
}

// Live Ingredients schema (cached ~5 min — one popup open asks several times).
let schemaCache = null;
export async function getSchema({ fresh = false } = {}) {
  if (!fresh && schemaCache && Date.now() - schemaCache.at < 5 * 60_000) return schemaCache.props;
  const ds = await api(`/data_sources/${INGREDIENTS_DS}`);
  schemaCache = { at: Date.now(), props: ds.properties || {} };
  return schemaCache.props;
}

const selectOptions = (props, name) => (props[name]?.select?.options || []).map((o) => o.name);
const plain = (rt) => (rt || []).map((t) => t.plain_text).join("").trim();

/** Live `Catagory` + `Unit type ` options for the dropdowns — read from the DB, never hardcoded. */
export async function getFieldOptions() {
  const props = await getSchema();
  return {
    categories: selectOptions(props, ING_PROPS.CATEGORY),
    unitTypes: selectOptions(props, ING_PROPS.UNIT_TYPE),
  };
}

/**
 * Preconditions for a SAFE write: a token that reaches the Ingredients DB, and every property this
 * extension writes actually present. Returns { ok, problems: [strings] }. The extension NEVER writes when
 * this fails — a missing property would otherwise be silently dropped by Notion, producing a half-filled row.
 */
export async function setupCheck() {
  if (!(await getToken())) return { ok: false, problems: ["No Notion token — open Options and paste the integration token."] };
  let props;
  try { props = await getSchema({ fresh: true }); } catch (e) { return { ok: false, problems: [`Cannot reach the Ingredients DB: ${e.message}`] }; }
  const missing = REQUIRED_ING_PROPS.filter((p) => !props[p]);
  const problems = missing.map((p) => `The Ingredients DB has no property named exactly "${p}" — add it in Notion (this tool never creates schema).`);
  return { ok: problems.length === 0, problems };
}

/** Rows whose title contains one of `needles`, deduped. Coarse server-side prefilter for findSimilar. */
async function queryByTitleNeedles(needles) {
  const or = needles.map((n) => ({ property: ING_PROPS.NAME, title: { contains: n } }));
  const res = await api(`/data_sources/${INGREDIENTS_DS}/query`, {
    method: "POST",
    body: { filter: or.length === 1 ? or[0] : { or }, page_size: 50 },
  });
  return res.results || [];
}

// Distinctive `title contains` needles from a product name: alphabetic words >= 4 chars, longest first,
// capped — a coarse prefilter only; the real decision is the local score() below.
function nameNeedles(name) {
  const words = String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/).filter((w) => w.length >= 4 && !/^\d+$/.test(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 3);
}

function rowSummary(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    notionUrl: page.url,
    name: plain(p[ING_PROPS.NAME]?.title),
    exactName: plain(p[ING_PROPS.EXACT_NAME]?.rich_text),
    price: p[ING_PROPS.PRICE]?.number ?? null,
    size: p[ING_PROPS.SIZE]?.number ?? null,
    category: p[ING_PROPS.CATEGORY]?.select?.name || "",
    unitType: p[ING_PROPS.UNIT_TYPE]?.select?.name || "",
    vendor: plain(p[ING_PROPS.VENDOR_CURRENT]?.rich_text),
  };
}

/**
 * Every ingredient row plausibly the SAME thing as `rawName` — the "Replace With This" candidates.
 *
 * Returns a LIST (best first), not one best match: the user asked for a button beside each similar item,
 * and which row you meant to replace is a judgement only they can make. Uses the scraper's own `score()`
 * so the extension and the daily comparison agree on what "similar" means.
 */
export async function findSimilar(rawName, { limit = 6 } = {}) {
  const needles = nameNeedles(rawName);
  if (!needles.length) return [];
  const pages = await queryByTitleNeedles(needles);
  const scored = [];
  for (const page of pages) {
    const summary = rowSummary(page);
    if (!summary.name) continue;
    const sc = score(rawName, summary.name);
    if (sc < REVIEW_THRESHOLD) continue;
    scored.push({ ...summary, score: Math.round(sc * 100) / 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Exact product-URL check, so re-opening the extension on a page already captured doesn't duplicate it.
 * Compared on href without a trailing slash or hash — enough for shop product pages, and deliberately not
 * a fuzzy match (a near-URL is a different product often enough that guessing would be wrong).
 */
const canonUrl = (u) => String(u || "").trim().replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();

export async function findByUrl(rawUrl) {
  const needle = canonUrl(rawUrl);
  if (!needle) return null;
  const props = await getSchema();
  if (!props[ING_PROPS.VENDOR_URL]) return null; // no URL column → skip the dup check rather than fail
  const res = await api(`/data_sources/${INGREDIENTS_DS}/query`, {
    method: "POST",
    body: { filter: { property: ING_PROPS.VENDOR_URL, url: { contains: needle.replace(/^https?:\/\//, "") } }, page_size: 25 },
  });
  for (const page of res.results || []) {
    const u = page.properties?.[ING_PROPS.VENDOR_URL]?.url;
    if (u && canonUrl(u) === needle) return rowSummary(page);
  }
  return null;
}

/**
 * Build the property payload shared by create and replace. A blank field is OMITTED rather than written as
 * null, so "I didn't read a size off this page" never blanks a size the row already had.
 *
 * Both selects are validated against the LIVE options first: sending a name Notion doesn't have would
 * silently CREATE a schema option, which this tool must never do.
 */
async function buildProps({ name, exactName, price, size, category, unitType, vendor, url }, props) {
  const out = {};
  if (name && name.trim()) out[ING_PROPS.NAME] = { title: [{ text: { content: name.trim().slice(0, 1990) } }] };
  if (exactName && exactName.trim()) out[ING_PROPS.EXACT_NAME] = { rich_text: [{ text: { content: exactName.trim().slice(0, 1990) } }] };
  if (typeof price === "number" && !Number.isNaN(price)) out[ING_PROPS.PRICE] = { number: price };
  if (typeof size === "number" && !Number.isNaN(size)) out[ING_PROPS.SIZE] = { number: size };
  if (vendor && vendor.trim()) out[ING_PROPS.VENDOR_CURRENT] = { rich_text: [{ text: { content: vendor.trim().slice(0, 1990) } }] };
  if (url && props[ING_PROPS.VENDOR_URL]) out[ING_PROPS.VENDOR_URL] = { url: String(url) };

  if (category && category.trim()) {
    if (!selectOptions(props, ING_PROPS.CATEGORY).includes(category)) {
      throw new Error(`"${category}" is not an existing "${ING_PROPS.CATEGORY}" option — refusing to write (it would create a schema option).`);
    }
    out[ING_PROPS.CATEGORY] = { select: { name: category } };
  }
  if (unitType && unitType.trim()) {
    if (!selectOptions(props, ING_PROPS.UNIT_TYPE).includes(unitType)) {
      throw new Error(`"${unitType}" is not an existing "${ING_PROPS.UNIT_TYPE}" option — refusing to write (it would create a schema option).`);
    }
    out[ING_PROPS.UNIT_TYPE] = { select: { name: unitType } };
  }
  return out;
}

/**
 * "Add to Ingredients" — create a new row.
 *
 * `fields.macros` is optional and only set when the figures were already known at write time — read off
 * the shop's own panel, or typed into the four boxes by hand. When it is absent the row is created without
 * nutrition and the caller may follow up with a lookup + `writeMacros`.
 */
export async function createIngredient(fields) {
  const check = await setupCheck();
  if (!check.ok) throw new Error(check.problems.join(" "));
  if (!fields.name || !fields.name.trim()) throw new Error("A name is required.");
  const props = await getSchema();
  const properties = await buildProps(fields, props);
  const macro = macroProperties(fields.macros, props);
  const page = await api("/pages", {
    method: "POST",
    body: {
      parent: { type: "data_source_id", data_source_id: INGREDIENTS_DS },
      properties: { ...properties, ...macro.properties },
    },
  });
  return { id: page.id, notionUrl: page.url, macrosWritten: macro.written, macrosSkipped: macro.skipped };
}

/**
 * The four nutrition columns as Notion properties.
 *
 * Shared by both write paths, because macros reach a row two different ways: read off the shop's own panel
 * and written WITH the row (createIngredient), or looked up afterwards and patched in (writeMacros).
 *
 * Every column is independent and optional — a source that gave protein and fat but not fibre writes the
 * two it has. A column missing from the schema is skipped with a note rather than failing the request:
 * these four are deliberately NOT in REQUIRED_ING_PROPS, because a renamed nutrition column is no reason
 * for the extension to stop capturing prices.
 */
function macroProperties(macros, props) {
  const properties = {};
  const written = [];
  const skipped = [];
  if (!macros) return { properties, written, skipped };
  for (const [prop, value, label] of [
    [ING_MACRO_PROPS.PROTEIN, macros.proteinPer100g, "Protein"],
    [ING_MACRO_PROPS.FATS, macros.fatsPer100g, "Fat"],
    [ING_MACRO_PROPS.CARBS, macros.carbsPer100g, "Carbs"],
    [ING_MACRO_PROPS.FIBER, macros.fiberPer100g, "Fibre"],
  ]) {
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    if (!props[prop]) { skipped.push(`${label} (no "${prop}" column)`); continue; }
    properties[prop] = { number: value };
    written.push(label);
  }
  return { properties, written, skipped };
}

/**
 * Fill in the four nutrition columns on a row that already exists.
 *
 * Used only when the figures had to be LOOKED UP — the shop published no panel, so the answer arrives ten
 * to thirty seconds after the row was written. Making the add wait on that would mean a spinner long
 * enough to give up on a row that was otherwise ready, so the row lands first and this patches it.
 *
 * When the page did carry a panel there is nothing to wait for, and the figures go in with the row via
 * createIngredient instead — one write, no window where the row exists without its nutrition.
 */
export async function writeMacros(pageId, macros) {
  if (!pageId) throw new Error("No row to write nutrition to.");
  if (!macros) return { written: [], skipped: [] };
  const props = await getSchema();
  const { properties, written, skipped } = macroProperties(macros, props);
  if (!written.length) return { written, skipped };

  await api(`/pages/${pageId}`, { method: "PATCH", body: { properties } });
  return { written, skipped };
}

/**
 * "Replace With This" — point an EXISTING row at this product.
 *
 * Overwrites Name, Items Exact Name, Price,SGD and Weight /Units of New Product, and sets Vendor, Current.
 * Items Exact Name is included deliberately: the row now describes a different physical product, and
 * leaving the old exact name behind would label it as something it is not.
 *
 * Everything else on the row is left ALONE — nutrition figures, plan formulas, `Select` tags and the
 * relations are the user's own work and have nothing to do with which shop the price came from.
 */
export async function replaceIngredient({ pageId, ...fields }) {
  const check = await setupCheck();
  if (!check.ok) throw new Error(check.problems.join(" "));
  if (!pageId) throw new Error("No row to replace.");
  if (!fields.name || !fields.name.trim()) throw new Error("A name is required.");
  const props = await getSchema();
  const properties = await buildProps(fields, props);
  const before = rowSummary(await api(`/pages/${pageId}`));
  const page = await api(`/pages/${pageId}`, { method: "PATCH", body: { properties } });
  return { id: page.id, notionUrl: page.url, before };
}
