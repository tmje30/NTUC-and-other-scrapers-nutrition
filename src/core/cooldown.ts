import { normSynonyms, stem } from "./match.js";

/**
 * Cooldowns — "I just bought this, stop showing it to me for a while."
 *
 * When an item is pushed to the Notion grocery list we work out how long that
 * pack will actually last, and suppress the item (and its close relatives) for
 * most of that stretch:
 *
 *     months covered = pack size ÷ monthly usage
 *     cooldown       = months covered × 0.75      ← deliberately 25% short
 *
 * The 25% haircut means the item comes back into the scan BEFORE the cupboard
 * is empty, leaving a window to catch a deal instead of being forced to buy at
 * full price. The user's worked example: 1 kg of garlic, 500 g used a month →
 * 2 months of cover → search again in 1.5 months.
 *
 * ⚠️ Rows tagged **`Weekly Buy`** opt out of that sum altogether and take a flat
 * 5 days — see `WEEKLY_BUY_COOLDOWN_DAYS`. Some things are bought on a rhythm
 * rather than when they run out.
 *
 * This module is pure (no I/O) so both the Node scripts and any future
 * serverless handler can share the same arithmetic. File persistence lives in
 * `cooldown-file.ts`.
 */

/** Days in an average month — cooldowns are expressed in days, not calendar months. */
const DAYS_PER_MONTH = 30.44;

/** Buy earlier than you run out: keep 25% of the cover as deal-hunting headroom. */
const HEADROOM = 0.75;

/**
 * Fallback for items with no monthly usage — anything outside the active plan,
 * where `pack ÷ usage` has no usage to divide by. Chosen by the user.
 */
export const NO_USAGE_COOLDOWN_DAYS = 14;

/**
 * Items tagged `Weekly Buy` in Notion are re-bought on a rhythm, not when the pack
 * runs out — bananas are a weekly shop whether you came home with three or a dozen.
 * So the pack-size sum is skipped entirely and the item comes back after 5 days.
 *
 * ⚠️ **This overrides the pack/usage arithmetic rather than adjusting it**, which
 * is the whole point of the tag: buying a bigger bunch must NOT buy more silence.
 * Left to the formula, a 2 kg buy against 1 kg/month would have gone quiet for
 * 46 days — six weeks of not being shown a fruit the user buys every week.
 *
 * Five and not seven, for the same reason the pack sum keeps a 25% haircut: the
 * item is back in the scan a couple of days before the next shop, so a deal can
 * actually be caught rather than found the day after it was needed.
 */
export const WEEKLY_BUY_COOLDOWN_DAYS = 5;

/** Guard rails against nonsense pack/usage data producing a decade-long silence. */
const MIN_DAYS = 1;
const MAX_DAYS = 365;

/**
 * Why an item is being skipped. `bought` is the original meaning — it's in the
 * cupboard. `ignored` is the page's "Ignore 1× week" button: nothing was bought,
 * the user just doesn't want to be shown it again this week. The page says which,
 * because "Recently bought" is a lie about an item you merely dismissed.
 */
export type CooldownReason = "bought" | "ignored";

export interface CooldownEntry {
	/** Base-noun key this cooldown suppresses (see `cooldownKey`). */
	key: string;
	/** The ingredient that was added, for display and for un-snoozing by hand. */
	ingredientId: string;
	ingredientName: string;
	/** Absent on entries written before this existed — read as "bought". */
	reason?: CooldownReason;
	/** When it was pushed to the grocery list, and when it comes back into the scan. */
	addedAt: string;
	until: string;
	days: number;
	/** Human-readable sum, so the JSON explains itself: "1kg ÷ 500g/mo × 0.75". */
	basis: string;
	/** What was actually bought — useful when reviewing the file months later. */
	store: string;
	product: string;
	packSizeG: number | null;
	monthlyAmount: number;
}

export interface CooldownFile {
	version: 1;
	updatedAt: string;
	entries: CooldownEntry[];
}

export const EMPTY_COOLDOWNS: CooldownFile = { version: 1, updatedAt: "", entries: [] };

/**
 * The suppression key: an ingredient's base noun, synonym-normalised and stemmed.
 *
 * Working on the base noun is what makes "and other closely related items" fall
 * out for free — `parseName` has already stripped the brand, the {notes} and the
 * (defining property), so "Onion (White)", "Onion (not red)" and "Onions" all
 * reduce to `onion`. Buying one silences the lot.
 *
 * It deliberately does NOT reach further than that: "Garlic" does not suppress
 * "Garlic Powder", and "Chicken Breast" does not suppress "Chicken Thigh" —
 * those are separate shopping decisions, not the same item spelled differently.
 */
export function cooldownKey(searchTerm: string): string {
	return normSynonyms(String(searchTerm || ""))
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean)
		.map(stem)
		.join(" ");
}

export interface CooldownPlan {
	days: number;
	until: string;
	basis: string;
}

/** Singapore is UTC+8 all year — no DST, so one constant is the whole conversion. */
const SGT_OFFSET_MS = 8 * 3_600_000;

/**
 * An ignore has to outlive at least one daily scan, or it did nothing at all.
 * Tapped on a Sunday evening, "the start of next week" is seven hours away and
 * the item is back on the very next morning's page — which is not what anyone
 * dismissing something means. Under a day of cover rolls to the Monday after.
 */
const MIN_IGNORE_MS = 86_400_000;

/**
 * How many weeks one tap of Ignore may buy. The page's dropdown offers 1–4, and
 * this is the ceiling the payload is clamped to on the way in — a hand-edited
 * issue body must not be able to silence an item for a year.
 */
export const MAX_IGNORE_WEEKS = 4;

/**
 * Midnight at the start of the week `weeks` ahead, Singapore time, as a UTC
 * instant.
 *
 * The week starts on MONDAY, so "ignore this for a week" from a Friday is quiet
 * over the weekend and back on Monday's scan — rather than a rolling seven days
 * that returns the item mid-week. Asked for on a Monday it means the FOLLOWING
 * Monday: a button labelled "1 week" that expired in a few hours would be a
 * button that did nothing.
 *
 * `weeks` (1–4, from the dropdown under the Ignore button) counts Mondays, not
 * 7-day blocks: 2 weeks from a Friday is the Monday after next, so however deep
 * into the week you tap, the item always comes back at the start of one. Extra
 * weeks are added as flat 7-day steps because Singapore has no DST — an hour of
 * drift is impossible here, unlike in a calendar-arithmetic version of the same
 * line.
 *
 * The date maths is done on a shifted clock (UTC getters reading SGT) because
 * the runner is a UTC machine, and "next Monday" there is the wrong Monday for
 * eight hours of every day.
 */
export function startOfNextWeek(from: Date = new Date(), weeks = 1): Date {
	const n = Math.min(MAX_IGNORE_WEEKS, Math.max(1, Math.round(weeks || 1)));
	const sgt = new Date(from.getTime() + SGT_OFFSET_MS);
	const daysAhead = (8 - sgt.getUTCDay()) % 7 || 7; // 0=Sun … 1=Mon; today-Monday ⇒ 7
	const midnight = (extra: number) =>
		Date.UTC(sgt.getUTCFullYear(), sgt.getUTCMonth(), sgt.getUTCDate() + daysAhead + extra) -
		SGT_OFFSET_MS;
	const soonest = midnight(0);
	const first = soonest - from.getTime() >= MIN_IGNORE_MS ? soonest : midnight(7);
	return new Date(first + (n - 1) * 7 * 86_400_000);
}

function packLabel(g: number, volumetric: boolean): string {
	const big = volumetric ? "L" : "kg";
	const small = volumetric ? "ml" : "g";
	return g >= 1000 ? `${+(g / 1000).toFixed(2)}${big}` : `${Math.round(g)}${small}`;
}

/** The flags that change how a cooldown is worked out. */
export interface CooldownOptions {
	/** Litres/ml rather than kg/g — display only, it does not change the sum. */
	volumetric?: boolean;
	/**
	 * The row is tagged `Weekly Buy`. Skips the pack/usage sum entirely — see
	 * `WEEKLY_BUY_COOLDOWN_DAYS`. An options object rather than a fifth positional
	 * argument on purpose: two adjacent booleans is a call nobody can read.
	 */
	weeklyBuy?: boolean;
}

/**
 * How long to stay quiet about an item after buying `packSizeG` of it.
 *
 * `packSizeG` is the size of the pack actually bought (the store product's), not
 * the user's usual pack — buying a 5 kg sack should buy more silence than the
 * 1 kg one they normally get. Falls back to a flat 14 days whenever the sum
 * can't be done (no monthly usage, or an unknown pack size).
 *
 * Three routes, and the order is deliberate:
 *
 *   1. `Weekly Buy`      → flat 5 days, whatever was bought
 *   2. pack ÷ usage      → the cover, less a 25% haircut
 *   3. neither is known  → flat 14 days
 *
 * The tag is checked FIRST because it means "ignore the arithmetic", not "adjust
 * it". Checking it later would let a big pack of a weekly item win a long silence
 * before the tag was ever consulted.
 */
export function planCooldown(
	packSizeG: number | null,
	monthlyAmount: number,
	from: Date = new Date(),
	opts: CooldownOptions = {},
): CooldownPlan {
	const { volumetric = false, weeklyBuy = false } = opts;
	let days: number;
	let basis: string;

	if (weeklyBuy) {
		days = WEEKLY_BUY_COOLDOWN_DAYS;
		basis = `weekly buy → flat ${WEEKLY_BUY_COOLDOWN_DAYS} days (pack size ignored)`;
	} else if (packSizeG && packSizeG > 0 && monthlyAmount > 0) {
		const months = packSizeG / monthlyAmount;
		days = months * HEADROOM * DAYS_PER_MONTH;
		basis =
			`${packLabel(packSizeG, volumetric)} ÷ ${packLabel(monthlyAmount, volumetric)}/month` +
			` = ${months.toFixed(2)} months × ${HEADROOM} = ${(months * HEADROOM).toFixed(2)} months`;
	} else {
		days = NO_USAGE_COOLDOWN_DAYS;
		basis = monthlyAmount > 0 ? "pack size unknown → flat 14 days" : "no monthly usage → flat 14 days";
	}

	const clamped = Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(days)));
	if (clamped !== Math.round(days)) basis += ` (capped at ${clamped} days)`;
	days = clamped;
	const until = new Date(from.getTime() + days * 86_400_000).toISOString();
	return { days, until, basis };
}

/** Entries that have not yet expired, as of `now`. */
export function activeEntries(file: CooldownFile, now: Date = new Date()): CooldownEntry[] {
	return (file.entries ?? []).filter((e) => Date.parse(e.until) > now.getTime());
}

/** The live cooldown for a base-noun key, or null if the item is fair game again. */
export function findCooldown(
	file: CooldownFile,
	key: string,
	now: Date = new Date(),
): CooldownEntry | null {
	let best: CooldownEntry | null = null;
	for (const e of activeEntries(file, now)) {
		if (e.key === key && (!best || Date.parse(e.until) > Date.parse(best.until))) best = e;
	}
	return best;
}

/**
 * Drop every cooldown on a key — the "Reset" button on the page, for when you
 * didn't actually buy it, or ate it faster than the sum assumed. Expired entries
 * go at the same time, since they're already inert.
 *
 * Returns the file plus the entries removed, so the caller can report exactly
 * what it un-snoozed rather than guessing.
 */
export function withoutCooldown(
	file: CooldownFile,
	key: string,
	now: Date = new Date(),
): { file: CooldownFile; removed: CooldownEntry[] } {
	const active = activeEntries(file, now);
	const removed = active.filter((e) => e.key === key);
	return {
		file: {
			version: 1,
			updatedAt: now.toISOString(),
			entries: active.filter((e) => e.key !== key),
		},
		removed,
	};
}

/**
 * Record a new cooldown, dropping expired entries and any earlier cooldown on the
 * same key (re-buying an item restarts its clock rather than stacking two).
 */
export function withCooldown(
	file: CooldownFile,
	entry: CooldownEntry,
	now: Date = new Date(),
): CooldownFile {
	const kept = activeEntries(file, now).filter((e) => e.key !== entry.key);
	return {
		version: 1,
		updatedAt: now.toISOString(),
		entries: [...kept, entry].sort((a, b) => a.until.localeCompare(b.until)),
	};
}
