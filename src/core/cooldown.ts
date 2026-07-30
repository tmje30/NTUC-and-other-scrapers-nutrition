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

/** Guard rails against nonsense pack/usage data producing a decade-long silence. */
const MIN_DAYS = 1;
const MAX_DAYS = 365;

export interface CooldownEntry {
	/** Base-noun key this cooldown suppresses (see `cooldownKey`). */
	key: string;
	/** The ingredient that was added, for display and for un-snoozing by hand. */
	ingredientId: string;
	ingredientName: string;
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

function packLabel(g: number, volumetric: boolean): string {
	const big = volumetric ? "L" : "kg";
	const small = volumetric ? "ml" : "g";
	return g >= 1000 ? `${+(g / 1000).toFixed(2)}${big}` : `${Math.round(g)}${small}`;
}

/**
 * How long to stay quiet about an item after buying `packSizeG` of it.
 *
 * `packSizeG` is the size of the pack actually bought (the store product's), not
 * the user's usual pack — buying a 5 kg sack should buy more silence than the
 * 1 kg one they normally get. Falls back to a flat 14 days whenever the sum
 * can't be done (no monthly usage, or an unknown pack size).
 */
export function planCooldown(
	packSizeG: number | null,
	monthlyAmount: number,
	from: Date = new Date(),
	volumetric = false,
): CooldownPlan {
	let days: number;
	let basis: string;

	if (packSizeG && packSizeG > 0 && monthlyAmount > 0) {
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
