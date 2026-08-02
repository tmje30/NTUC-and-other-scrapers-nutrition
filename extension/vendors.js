// Host → the vendor name written into "Vendor, Current ".
//
// The reference extension this is modelled on resolves vendors from a Notion logins DB. This project has
// no such DB, and only a handful of SG grocers matter, so the map is inline. It is a CONVENIENCE, not a
// gate: unlike the reference, an unknown site is not refused — the vendor box is simply pre-filled with the
// bare host and stays editable. "Vendor, Current " is rich text, so no Notion option can be invented by it.
//
// Names are spelled to match the existing "Vendor 1/2/3" select options in the Ingredients DB, so the text
// written here reads the same as the vendors already recorded by hand. NTUC's shop is fairprice.com.sg —
// the site says FairPrice, the user's DB says NTUC, and the DB wins.
export const VENDOR_BY_HOST = [
  [/(^|\.)fairprice\.com\.sg$/i, "NTUC"],
  [/(^|\.)shengsiong\.com\.sg$/i, "Sheng Siong"],
  [/(^|\.)allforyou\.sg$/i, "Sheng Siong"],
  [/(^|\.)watsons\.com\.sg$/i, "Watsons"],
  [/(^|\.)guardian\.com\.sg$/i, "Guardian"],
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
