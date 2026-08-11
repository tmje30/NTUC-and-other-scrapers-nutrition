import { check, describe } from "./harness.js";
import { isUsableScan, scanTermCount } from "../core/stores/shengsiong-file.js";

/**
 * What counts as a usable Sheng Siong scan file.
 *
 * ⚠️ **The case these exist for is `{date: today, terms: 0, results: {}}`.** On
 * 2026-08-09 the runner fetched a `targets.json` that listed no terms, "scanned"
 * all zero of them, wrote that file, pushed it and exited 0. Every layer read it
 * as a success: Task Scheduler saw 0, the log said "Wrote … (0 terms, 0 errors)",
 * and the cloud reader — which only checked the date — would have called it fresh,
 * published the page with **no ⚠️ banner**, and returned nothing for every Sheng
 * Siong lookup. Nothing in the chain disagreed with anything else, which is why it
 * survived. Both ends now refuse it: the writer never produces one, the reader
 * never trusts one.
 */
describe("scan file — an empty scan is not a scan");

const TODAY = "2026-08-11";
const real = { date: TODAY, terms: 62, results: { Milk: [{ name: "Milk" }] } };

check("a real scan dated today is usable", isUsableScan(real, TODAY));
check("the same scan dated yesterday is not", !isUsableScan({ ...real, date: "2026-08-10" }, TODAY));

check(
	"⚠️ today's date with zero terms is NOT usable",
	!isUsableScan({ date: TODAY, terms: 0, results: {} }, TODAY),
);
check(
	"…nor is it usable when `terms` is absent and results are empty",
	!isUsableScan({ date: TODAY, results: {} }, TODAY),
);
check("a missing results object is not usable", !isUsableScan({ date: TODAY, terms: 62 }, TODAY));
check("garbage is not usable", !isUsableScan(null, TODAY) && !isUsableScan({}, TODAY));

// A term that legitimately found nothing is still a term that was searched — the
// runner asks 62 shops' worth of questions and several always come back empty
// (`Muscovado Sugar: 0` on every run). Requiring products, rather than terms,
// would throw away good scans.
check(
	"a scan whose terms all returned nothing is still a scan",
	isUsableScan({ date: TODAY, terms: 3, results: { a: [], b: [], c: [] } }, TODAY),
);

// Files written before `terms` existed as a field fall back to counting keys, so
// an old file in a stale clone still reads correctly rather than looking empty.
check("legacy file with no `terms` field counts its result keys", scanTermCount({ results: { a: [], b: [] } }) === 2);
check("`terms` wins when present", scanTermCount({ terms: 62, results: { a: [] } }) === 62);
check("nothing at all counts zero", scanTermCount(undefined) === 0);
