import { searchesStore } from "../core/run.js";
import type { PlanTarget } from "../core/notion.js";
import { check, describe } from "./harness.js";

/**
 * A shop is asked only when the row names it.
 *
 * ⚠️ **This reverses a rule the handover warned loudly about**, and the warning
 * was right when it was written: "the tags mean *also* look here, never *only*
 * look here… code that treats an empty tag as 'don't search' would silently kill
 * the FairPrice scan on 42 rows." That described a database where `Sheng Siong`
 * appeared on **zero** rows. `vendor-scan` has been filling the slots since
 * 2026-08-09, and the day this changed **49 of 52 targets named both
 * supermarkets** — the three that didn't were the whey rows, which are bought at
 * Shopee and MyProtein and had been searched at NTUC every day for nothing.
 *
 * ⚠️ **So this rule is measurement-dependent and the measurement has already
 * flipped once.** It fails in the quiet direction: if a shop stops being tagged,
 * nothing errors, the page just has fewer deals. Re-count before trusting it.
 */
describe("directed search — a shop is asked only when the row names it");

const target = (vendors: string[]): PlanTarget => ({ vendors } as unknown as PlanTarget);

check("a row naming NTUC is searched at FairPrice", searchesStore(target(["NTUC"]), "FairPrice"));
check(
	"⚠️ 'FairPrice' the module is 'NTUC' the Notion option — the mapping is load-bearing",
	searchesStore(target(["NTUC"]), "FairPrice") && !searchesStore(target(["FairPrice"]), "Sheng Siong"),
);
check("a row naming Sheng Siong is searched there", searchesStore(target(["Sheng Siong"]), "Sheng Siong"));
check(
	"…and not at the shop it doesn't name",
	!searchesStore(target(["Sheng Siong"]), "FairPrice"),
);

// The live case that prompted the change: whey, bought online, asked of a
// supermarket every day for nothing.
const whey = target(["Shopee", "Carousell", "My Protein", "Google Search"]);
check("⚠️ whey is not searched at NTUC", !searchesStore(whey, "FairPrice"));
check("⚠️ nor at Sheng Siong", !searchesStore(whey, "Sheng Siong"));

// A row with no slots at all is already dropped upstream (`readBaseline` refuses
// it a baseline), but the belt-and-braces answer here is still "no".
check("no vendors at all means no shop", !searchesStore(target([]), "FairPrice"));

// Tag comparison folds case and spacing, like every other tag read in this
// project — a cosmetic edit in Notion must not silently stop a shop being asked.
check("case and spacing are folded", searchesStore(target(["  sheng  siong "]), "Sheng Siong"));
