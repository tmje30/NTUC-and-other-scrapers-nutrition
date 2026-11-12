import { readFileSync } from "node:fs";
import type { Deal } from "../core/compare.js";
import { oneTapScript, relayOneTap } from "../core/page-chrome.js";
import { renderDealsPage } from "../core/site.js";
import { renderHistoryPage } from "../core/history.js";
import { renderReviewPage } from "../core/review-page.js";
import { check, describe, eq } from "./harness.js";

/**
 * **One tap, and the two credentials that can carry it** (user, 2026-11-12: "set up the
 * relay path so it never expires").
 *
 * The pages used to one-tap by holding a fine-grained GitHub PAT in each browser's
 * `localStorage`. It worked for three months and then expired without a word: the token
 * died on 10-26, the first tap afterwards got a 401, the script deleted it exactly as
 * designed, and every tap after that quietly opened the GitHub issue form instead. The
 * privileged half now lives in the Cloudflare relay, and the page carries only a
 * narrow baked secret.
 *
 * What these cases guard is not the happy path — it is the three things that would make
 * this change a downgrade:
 *
 *  1. **The floor survives.** Every button must stay a real `<a href>` to a pre-filled
 *     issue. A relay build that rendered a bare `<button>` would have no fallback at all,
 *     which is worse than what it replaced.
 *  2. **Half a configuration does not ship.** An endpoint with no secret must fall back,
 *     not send `X-Add-Secret: undefined` and have every tap refused.
 *  3. **The allow-list covers the buttons.** The relay refuses any event outside
 *     `ADD_EVENTS`, so a button whose event is missing from that set is a button that
 *     silently stops working on the relay build only.
 */
describe("one-tap — the relay path and the PAT it replaced");

// ── fixtures ────────────────────────────────────────────────────────────────

const RELAY = "https://relay.example/add";
const SECRET = "add-s3cret";

const target = (over: Record<string, unknown> = {}) =>
	({
		name: "Peanut Butter, Smooth",
		ingredientId: "ing-1",
		packPriceSgd: 8.2,
		packSize: 500,
		packWeightG: 500,
		monthlyAmount: 400,
		monthlyAmountG: 400,
		unitType: "By Gram",
		inActivePlan: true,
		search: { searchTerm: "peanut butter", mustMatch: [], properties: [], keywords: [] },
		...over,
	}) as any;

const product = (over: Record<string, unknown> = {}) =>
	({
		store: "FairPrice",
		name: "Skippy Peanut Butter Spread - Creamy",
		priceSgd: 5.65,
		packWeightG: 500,
		volumetric: false,
		unitCount: null,
		pricePer100g: 1.13,
		dietaryAttributes: [],
		onSale: true,
		listPriceSgd: 6.65,
		saleEndsAt: null,
		url: "https://www.fairprice.com.sg/product/skippy-peanut-butter-creamy-500g-47440",
		nutritionHtml: null,
		...over,
	}) as any;

const DEAL = {
	target: target(),
	product: product(),
	savingPct: 31,
	baseline: 1.64,
	productPrice: 1.13,
	dimension: "weight",
} as unknown as Deal;

const deals = (o: Record<string, unknown>) =>
	renderDealsPage([DEAL], [], new Date(), [], { repo: "owner/repo", ...o } as any);

const history = (o: Record<string, unknown>) =>
	renderHistoryPage({
		repo: "owner/repo",
		parked: [],
		purchases: { entries: [] },
		exclusions: { blocks: [] },
		...o,
	} as any);

const review = (o: Record<string, unknown>) =>
	renderReviewPage([], { repo: "owner/repo", ignored: [], ...o } as any);

const LIVE = { addEndpoint: RELAY, addSecret: SECRET };

// ── relayOneTap: both halves or neither ─────────────────────────────────────

eq("an endpoint and a secret is one-tap", relayOneTap({ repo: "r", ...LIVE }), true);
eq("an endpoint alone is not", relayOneTap({ repo: "r", addEndpoint: RELAY }), false);
eq("a secret alone is not", relayOneTap({ repo: "r", addSecret: SECRET }), false);
eq("neither is not", relayOneTap({ repo: "r" }), false);
// ⚠️ An empty string is what `optional()` can hand back for an unset variable, and it
// must count as absent — a page built with ADD_SECRET="" would otherwise send an empty
// secret at the relay and have every tap refused.
eq("an empty secret is absent, not present", relayOneTap({ repo: "r", addEndpoint: RELAY, addSecret: "" }), false);

// ── the script, on each route ───────────────────────────────────────────────

const relayJs = oneTapScript({ repo: "owner/repo", ...LIVE });
const patJs = oneTapScript({ repo: "owner/repo" });

check("the relay script posts the relay", relayJs.includes(`var RELAY = {"url":"${RELAY}"`));
check("…carrying the secret in a header", relayJs.includes('"X-Add-Secret": RELAY.secret'));
check("…and the secret itself", relayJs.includes(SECRET));
check("the PAT script has no relay", patJs.includes("var RELAY = null;"));
check("…and never names the add header's value", !patJs.includes(SECRET));
// ⚠️ The api.github.com branch is still in BOTH scripts and that is deliberate: it is one
// script with two transports, and a build with no secret has to keep working.
check("both scripts can still reach GitHub directly", relayJs.includes("api.github.com") && patJs.includes("api.github.com"));

// ⚠️ The gate the whole fallback rests on. A relay build must one-tap without asking the
// browser for anything; a PAT build must do nothing when there is no token, so that the
// click falls through to the link.
check("the relay route needs no stored token", relayJs.includes("RELAY ? !refused : Boolean(token())"));
check("…and a refusal stops it intercepting", relayJs.includes("if (RELAY) refused = true;"));

// ── the floor: every button is still a link ─────────────────────────────────

const dealsRelay = deals(LIVE);
const dealsPat = deals({});

check("Buy is an anchor on a relay build", /<a class="add" href="https:\/\/github\.com\/owner\/repo\/issues\/new/.test(dealsRelay));
check("…exactly as on a PAT build", /<a class="add" href="https:\/\/github\.com\/owner\/repo\/issues\/new/.test(dealsPat));
// ⚠️ The regression this change could most easily have shipped. Until 2026-11-12 a
// configured endpoint rendered `<button class="add">` with no href at all.
check("no button has replaced the Buy link", !dealsRelay.includes('<button class="add"'));
check("the payload still rides on it", dealsRelay.includes("data-payload="));

// ── the footer toggle belongs to the PAT route only ─────────────────────────

for (const [name, live, pat] of [
	["deals", dealsRelay, dealsPat],
	["history", history(LIVE), history({})],
	["review", review(LIVE), review({})],
] as const) {
	check(`${name}: a relay build offers nothing to enable`, !live.includes('id="onetap"'));
	check(`${name}: a PAT build still offers it`, pat.includes('id="onetap"'));
	check(`${name}: the relay build carries the secret`, live.includes(SECRET));
	// ⚠️ The secret must not reach a page that was built without it, in any form.
	check(`${name}: a PAT build carries no secret`, !pat.includes(SECRET));
	check(`${name}: and never an undefined one`, !pat.includes("X-Add-Secret: undefined") && !live.includes("undefined"));
}

// ── addEventsMatchPages ─────────────────────────────────────────────────────
//
// ⚠️⚠️ **The relay's allow-list and the pages' buttons have to agree, and nothing else
// checks it.** `handleAdd` refuses any event outside `ADD_EVENTS`, so a new button with a
// new `data-event` would work on a PAT build (which sends the event straight to GitHub)
// and be refused on the relay build — the one the user actually has. Compared against the
// SOURCE rather than against rendered pages on purpose: a fixture only exercises the
// buttons it happens to include, and the button that gets forgotten is the rare one.

const worker = readFileSync("relay/worker.mjs", "utf8");
const allowed = new Set(
	(/const ADD_EVENTS = new Set\(\[([^\]]*)\]\)/.exec(worker)?.[1] ?? "")
		.split(",")
		.map((s) => s.trim().replace(/^"|"$/g, ""))
		.filter(Boolean),
);

eq("the allow-list parsed out of the Worker", [...allowed].sort(), ["add-to-list", "item-action", "sscan"]);

const used = new Set<string>(["add-to-list"]); // the default in `send`, used by every Buy
for (const f of ["site.ts", "history.ts", "review-page.ts", "page-chrome.ts"]) {
	const src = readFileSync(`src/core/${f}`, "utf8");
	for (const m of src.matchAll(/data-event="([a-z-]+)"/g)) used.add(m[1]);
}

eq("every event a page can send is allowed by the relay", [...used].filter((e) => !allowed.has(e)), []);
// The other direction: a grant nobody uses is a door left open for no reason.
eq("every allowed event is one a page actually sends", [...allowed].filter((e) => !used.has(e)), []);
