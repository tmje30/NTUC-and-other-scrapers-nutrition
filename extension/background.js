// Service worker — the only place Notion is called from. The popup / side panel talk to it with
// chrome.runtime messages; it answers with plain JSON. All Notion specifics live in notion-client.js.
//
// The name/category/size logic is IMPORTED from the project's own core (src/core/*), not copied, so the
// extension and the daily scraper always agree on what a generic name and a category are.
import { deriveGenericName } from "../src/core/generic-name.js";
import { categorize, matchCategoryOption, guessSize } from "../src/core/categorize.js";
import { findSimilar, findByUrl, createIngredient, replaceIngredient, setupCheck, getFieldOptions } from "./notion-client.js";
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
  return n;
}

/** Size field → a positive number, or null. Tolerates "500", "500 g", "1,5". */
function sizeOf(text) {
  if (text == null || String(text).trim() === "") return null;
  const n = Number.parseFloat(String(text).replace(",", ".").replace(/[^\d.]/g, ""));
  return !Number.isNaN(n) && n > 0 ? n : null;
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

const handlers = {
  // Opened on a page: can we write at all, and which vendor is this? Unlike the reference extension there
  // is no vendor gate — an unrecognised host still captures, with the host as the vendor label.
  async "setup-check"({ url }) {
    const res = await setupCheck();
    const { host, vendor, known } = vendorForUrl(url);
    return { ...res, host, vendor, known };
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
  async "derive"({ name, brand, sizeText }) {
    const exactName = [String(name || "").trim(), String(brand || "").trim()]
      .filter(Boolean)
      // Only append the brand when the title doesn't already carry it — shops repeat it about half the time.
      .reduce((acc, part) => (acc.toLowerCase().includes(part.toLowerCase()) ? acc : `${acc} ${part}`.trim()), "");
    const generic = deriveGenericName(name || "", brand || "");
    const { categories } = await getFieldOptions();
    const category = matchCategoryOption(categorize(generic || name || ""), categories) || "";
    const { amount, unitType } = guessSize(sizeText || "");
    return { generic, exactName, category, size: amount, unitType: unitType || "" };
  },

  // Ingredient rows this product might already BE — each gets a "Replace With This" button.
  async "find-similar"({ name }) {
    if (!name || !String(name).trim()) return { items: [] };
    return { items: await findSimilar(String(name)) };
  },

  // "Add to Ingredients" — a new row.
  async "add-item"(m) {
    const existing = await findByUrl(m.url); // re-check right before writing (the form may have raced)
    if (existing) return { ok: false, duplicate: existing };
    const created = await createIngredient(fieldsFrom(m));
    return { ok: true, created };
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
