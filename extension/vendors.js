// Host → the shop this capture is tagged with, in the "Vendor 1..4" columns.
//
// The reference extension this is modelled on resolves vendors from a Notion logins DB. This project has
// no such DB, and only a handful of SG grocers matter, so the map is inline. It is a CONVENIENCE, not a
// gate: unlike the reference, an unknown site is not refused — the vendor box is simply pre-filled with the
// bare host and stays editable, and the capture still writes a row.
//
// ⚠️ Names are spelled to match the "Vendor 1..4" select OPTIONS in the Ingredients DB, and that spelling is
// now load-bearing. A capture claims a vendor slot, and `Vendor n` is a select — so a name Notion doesn't
// already offer would make Notion INVENT the option, a schema edit to a live personal workspace. The write
// refuses instead and tells the user, which is why "Iherb" is spelled the DB's way and not iHerb's.
//
// The live options, 2026-08-09:
//   NTUC · Sheng Siong · Watsons · Guardian · Carousell · Shopee · Iherb · Google Search · My Protein
//
// NTUC's shop is fairprice.com.sg — the site says FairPrice, the user's DB says NTUC, and the DB wins.
//
// The last four entries have NO matching option today. They are kept deliberately: an unmapped host falls
// back to its bare hostname, and "coldstorage.com.sg" in the vendor box is a worse thing to read — and a
// worse thing to be told is unwritable — than "Cold Storage". Capture still works; only the price-book
// write is skipped, with a message naming the shop.
export const VENDOR_BY_HOST = [
  [/(^|\.)fairprice\.com\.sg$/i, "NTUC"],
  [/(^|\.)shengsiong\.com\.sg$/i, "Sheng Siong"],
  [/(^|\.)allforyou\.sg$/i, "Sheng Siong"],
  [/(^|\.)watsons\.com\.sg$/i, "Watsons"],
  [/(^|\.)guardian\.com\.sg$/i, "Guardian"],
  [/(^|\.)iherb\.com$/i, "Iherb"],
  [/(^|\.)myprotein\.com(\.sg)?$/i, "My Protein"],
  [/(^|\.)carousell\.sg$/i, "Carousell"],
  [/(^|\.)shopee\.sg$/i, "Shopee"],
  [/(^|\.)coldstorage\.com\.sg$/i, "Cold Storage"],
  [/(^|\.)giant\.sg$/i, "Giant"],
  [/(^|\.)redmart\.lazada\.sg$/i, "RedMart"],
  [/(^|\.)lazada\.sg$/i, "Lazada"],
  [/(^|\.)amazon\.sg$/i, "Amazon SG"],
];

/** Host of a URL, lowercased, without "www." — "" when it can't be parsed. */
export function hostOf(u) {
  const s = String(u || "").trim();
  if (!s) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try { return new URL(withScheme).host.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}

/**
 * Vendor label for a page URL. Falls back to the bare host so an unrecognised shop still records WHERE the
 * price came from — a wrong-looking vendor the user can correct beats a blank one they won't notice.
 */
export function vendorForUrl(url) {
  const host = hostOf(url);
  if (!host) return { host: "", vendor: "", known: false };
  for (const [re, name] of VENDOR_BY_HOST) if (re.test(host)) return { host, vendor: name, known: true };
  return { host, vendor: host, known: false };
}
