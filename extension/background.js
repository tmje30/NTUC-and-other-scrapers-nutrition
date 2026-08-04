// Service worker — the only place Notion is called from. The popup / side panel talk to it with
// chrome.runtime messages; it answers with plain JSON. All Notion specifics live in notion-client.js.
//
// The name/category/size logic is IMPORTED from the project's own core (src/core/*), not copied, so the
// extension and the daily scraper always agree on what a generic name and a category are.
import { deriveGenericName, stripStructure, structuredName } from "../src/core/generic-name.js";
import { categorize, matchCategoryOption, guessSize } from "../src/core/categorize.js";
import { parseNutritionPanel } from "../src/core/nutrition-panel.js";
import { findSimilar, findByUrl, createIngredient, replaceIngredient, setupCheck, getFieldOptions, writeMacros } from "./notion-client.js";
import { lookupMacros, macrosConfigured } from "./macros-client.js";
import { vendorForUrl } from "./vendors.js";

/**
 * Price text → a number, or null when blank. Handles the SG shapes: "$4.30", "S$4.30", "4,30", "4.30/ea".
 * An unparseable NON-blank throws, so the user fixes the box instead of writing a garbage price.
 */
function priceOf(priceText) {
  if (priceText == null || String(priceText).trim() === "") return null;
  const s = String(priceText).replace(/[^\d.,]/g, "");
  if (!s) throw new Error(`Could not read "${priceText}" as a price — fix it or clear the field.`);
  // A lone comma is a decimal separator ("4,30"); commas among dots are thousands separators.
  const norm = s.includes(".") ? s.replace(/,/g, "") : s.replace(",", ".");
  const n = Number.parseFloat(norm);
  if (Number.isNaN(n) || n < 0) throw new Error(`Could not read "${priceText}" as a price — fix it or clear the field.`);
  // Round HERE as well as at extraction: this is the last gate before Notion, and it also catches a value
  // typed or pasted by hand. A price is money — two decimals, never 7.949999999999999.
  return Math.round(n * 100) / 100;
}

/**
 * Size field → a positive number, or null. Tolerates "500", "500 g", "1,5".
 * Rounded to 3 dp so a unit conversion (1.5 kg → 1500) can't arrive as 1499.9999999999998.
 */
function sizeOf(text) {
  if (text == null || String(text).trim() === "") return null;
  const n = Number.parseFloat(String(text).replace(",", ".").replace(/[^\d.]/g, ""));
  return !Number.isNaN(n) && n > 0 ? Math.round(n * 1000) / 1000 : null;
}

// Fields shared by both writes, read straight off the form.
const fieldsFrom = (m) => ({
  name: m.name,
  exactName: m.exactName,
  price: priceOf(m.priceText),
  size: sizeOf(m.sizeText),
  category: m.category || "",
  unitType: m.unitType || "",
  vendor: m.vendor || "",
  url: m.url || "",
});

/**
 * A macro box → grams per 100g, or null when blank.
 *
 * Unparseable is treated as blank rather than thrown, unlike `priceOf`: a price is money and a wrong one
 * is worth stopping for, but a nutrition box is one of four optional columns beside it. Values outside
 * 0–100 are dropped — nothing in 100 g of food weighs more than 100 g.
 */
function macroOf(text) {
  if (text == null || String(text).trim() === "") return null;
  const n = Number.parseFloat(String(text).replace(",", ".").replace(/[^\d.]/g, ""));
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return Math.round(n * 100) / 100;
}

/** The four boxes as a Macros object, or null when the user left every one of them empty. */
function macrosFrom(m) {
  const macros = {
    proteinPer100g: macroOf(m.protein),
    fatsPer100g: macroOf(m.fats),
    carbsPer100g: macroOf(m.carbs),
    fiberPer100g: macroOf(m.fiber),
  };
  return Object.values(macros).some((v) => v != null) ? macros : null;
}

const handlers = {
  // Opened on a page: can we write at all, and which vendor is this? Unlike the reference extension there
  // is no vendor gate — an unrecognised host still captures, with the host as the vendor label.
  async "setup-check"({ url }) {
    const res = await setupCheck();
    const { host, vendor, known } = vendorForUrl(url);
    // Reported but never a `problem`: the nutrition lookup is optional, and a missing Claude key must not
    // stop the extension writing prices. It only changes what the empty macro boxes say they'll do.
    return { ...res, host, vendor, known, macrosConfigured: await macrosConfigured() };
  },

  // Options-page "Save & test".
  async "token-test"() {
    return await setupCheck();
  },

  // Live `Catagory` + `Unit type ` options for the dropdowns.
  async "field-options"() {
    return await getFieldOptions();
  },

  // Already captured this exact product page?
  async "check-url"({ url }) {
    const existing = await findByUrl(url);
    return existing ? { found: true, existing } : { found: false };
  },

  /**
   * Turn a raw page reading into the form's starting values: the generic Name, the exact name, a category
   * guess resolved against the LIVE options, and a size + unit type. Done in the worker so the popup and the
   * side panel can't drift apart on it.
   */
  async "derive"({ name, brand, sizeText, nutritionHtml }) {
    const exactName = [String(name || "").trim(), String(brand || "").trim()]
      .filter(Boolean)
      // Only append the brand when the title doesn't already carry it — shops repeat it about half the time.
      .reduce((acc, part) => (acc.toLowerCase().includes(part.toLowerCase()) ? acc : `${acc} ${part}`.trim()), "");
    const generic = deriveGenericName(name || "", brand || "");
    // The Name box gets the user's own bracket standard — "Peanut Butter [Skippy] {Creamy}" — because
    // that column is the one `parse.ts` reads to build the search. `generic` stays plain and is what the
    // category guess and the similar-rows search use; brackets there would match on punctuation.
    // The variant lands in { } (ignored by the matcher) rather than ( ) (a hard requirement) on purpose:
    // "(Crunchy)" would reject the smooth jar that is actually on offer. See `structuredName`.
    const structured = structuredName(name || "", brand || "");
    const { categories } = await getFieldOptions();
    const category = matchCategoryOption(categorize(generic || name || ""), categories) || "";
    const { amount, unitType } = guessSize(sizeText || "");
    // The shop's own panel, if it published one. Free and authoritative, so it beats the paid lookup —
    // which is why it runs here at render time rather than at Add. null whenever the page said nothing or
    // said something that didn't survive the per-100g sanity check, and then the boxes stay empty.
    const panel = nutritionHtml ? parseNutritionPanel(nutritionHtml) : null;
    return { generic, structured, exactName, category, size: amount, unitType: unitType || "", panel };
  },

  // Ingredient rows this product might already BE — each gets a "Replace With This" button.
  async "find-similar"({ name }) {
    // Brackets off first. The Name box now carries the structure ("[Skippy]", "{Creamy}"), and searching
    // Notion for punctuation — or for the brand, which the standard says is NOT part of the search —
    // finds nothing. `stripStructure` is the same helper the category guess uses.
    const plain = stripStructure(String(name || ""));
    if (!plain.trim()) return { items: [] };
    return { items: await findSimilar(plain) };
  },

  // "Add to Ingredients" — a new row.
  async "add-item"(m) {
    const existing = await findByUrl(m.url); // re-check right before writing (the form may have raced)
    if (existing) return { ok: false, duplicate: existing };

    // Whatever is in the four boxes wins: it came off the shop's own panel or out of the user's head, and
    // either beats a lookup. Only a completely empty set triggers the paid fallback.
    const macros = macrosFrom(m);
    const created = await createIngredient({ ...fieldsFrom(m), macros });

    // `needsLookup` is told to the caller so it can show "looking up nutrition…" only when a lookup is
    // actually coming — no key, or figures already present, must not leave a spinner running forever.
    return {
      ok: true,
      created,
      needsLookup: !macros && (await macrosConfigured()),
      macrosFromForm: Boolean(macros),
    };
  },

  /**
   * "Find Macros" — look the figures up and hand them BACK, writing nothing.
   *
   * Deliberately different from `macros-for` below, which needs a row to patch. This
   * runs BEFORE the row exists, so the four boxes fill and the user reads them,
   * edits them, or clears them before anything reaches Notion. That ordering is the
   * whole point of the button: a lookup costs US$0.003–0.29 and is occasionally
   * wrong, and figures you approved are worth more than figures that appeared
   * behind your back.
   *
   * Only ever reached by a deliberate press — see `flow.js`. Nothing in this
   * extension starts a paid lookup on its own any more.
   */
  async "find-macros"({ name, exactName, vendor, url, category, images }) {
    if (!(await macrosConfigured())) return { ok: false, reason: "no-key" };
    const macros = await lookupMacros({
      product: exactName || name || "",
      store: vendor || "",
      url: url || "",
      ingredientName: name || "",
      category: category || "",
      categoryKey: categorize(name || exactName || "") || undefined,
      images: Array.isArray(images) ? images : [],
    });
    return macros ? { ok: true, macros } : { ok: false, reason: "not-found" };
  },

  /**
   * Look up the four nutrition figures for a row just added, and write them.
   *
   * A SECOND round trip, deliberately: the lookup reads the product page and may search, which takes ten
   * to thirty seconds, and the add itself must not wait on it. Notably this runs in the WORKER, so it
   * survives the popup closing — the row gets its macros whether or not anyone is still watching. Only
   * the "here's what it found" message is lost in that case.
   *
   * Never throws. There is nothing to roll back: the row exists and is correct, just without nutrition,
   * and the reply says which of the two happened.
   */
  async "macros-for"({ pageId, name, exactName, vendor, url, category, images }) {
    if (!pageId) throw new Error("No row to look up nutrition for.");
    if (!(await macrosConfigured())) return { ok: false, reason: "no-key" };

    const macros = await lookupMacros({
      // The shop's own wording is the better search term; the generic name is the fallback.
      product: exactName || name || "",
      store: vendor || "",
      url: url || "",
      ingredientName: name || "",
      category: category || "",
      // The project's own key ("produce", "protein"), NOT the Notion option name in `category` — it is
      // what `isCommodityFood` branches on to decide whether searching is worth paying for, and the
      // user can rename their Notion options at any time.
      categoryKey: categorize(name || exactName || "") || undefined,
      // The shop's own pack shots. Passed whole — `selectPackShots` keeps the back and side views and
      // drops the front, because a marketing face with no panel is what made this back-fire on frozen
      // chicken. When it keeps none, the lookup is exactly the text-only one it was before.
      images: Array.isArray(images) ? images : [],
    });
    if (!macros) return { ok: false, reason: "not-found" };

    const { written, skipped } = await writeMacros(pageId, macros);
    return { ok: true, macros, written, skipped };
  },

  // "Replace With This" — repoint an existing row at this product.
  async "replace-item"(m) {
    if (!m.pageId) throw new Error("No row selected to replace.");
    const updated = await replaceIngredient({ pageId: m.pageId, ...fieldsFrom(m) });
    return { ok: true, updated };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  h(msg)
    .then((result) => sendResponse({ result }))
    .catch((e) => sendResponse({ error: e?.message || String(e) }));
  return true; // async sendResponse
});
