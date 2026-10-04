import type { Client } from "@notionhq/client";
import { normTag, queryAll } from "./notion.js";

/**
 * **Which shops you can actually get to, from the Website Used DB.**
 *
 * The shopping page's Location toggle answers one question per mode: *of the shops I will
 * pass today, which is cheapest for this row?* "Cheapest" ignores geography entirely and is
 * what the page has always shown; `home` and `work` narrow the vendor slots to the shops
 * tagged for that trip before picking a winner.
 *
 * ⚠️ **The tags are the user's and live in `Website Used`.** Its `Select` multi-select held
 * `Home`, `Office Toby` and `Office ML` when this was written (introspected 2026-10-04).
 * Nothing here creates or edits them — see CLAUDE.md.
 *
 * ⚠️ **`work` is `Office Toby` ONLY** (user's call, 2026-10-04, asked because the DB has two
 * office tags and the request named one "Work"). `Office ML` is deliberately not folded in:
 * guessing that two offices are interchangeable would quietly send you to the wrong one.
 */
export type LocationMode = "cheapest" | "home" | "work";

/** The modes in the order the toggle shows them. `cheapest` is the default and is first. */
export const LOCATION_MODES: LocationMode[] = ["cheapest", "home", "work"];

/** What the toggle calls each mode. */
export const LOCATION_LABELS: Record<LocationMode, string> = {
	cheapest: "Cheapest",
	home: "Home",
	work: "Work",
};

/**
 * The `Select` option each mode requires, or null for "no filter at all".
 *
 * ⚠️ Compared through `normTag`, never `===`. Every other vendor comparison in this project
 * goes through it for the same reason: the options are typed by a human and `Don'r Search`
 * is a real spelling that shipped (see `notion.ts`).
 */
export const LOCATION_TAGS: Record<LocationMode, string | null> = {
	cheapest: null,
	home: "Home",
	work: "Office Toby",
};

/** The Website Used data source. Introspected 2026-10-04; the shops and their tags live here. */
export const WEBSITE_USED_DS = "3b169a18-4fe7-80ad-b5f9-000b8824812f";

/** Shop name → the location tags it carries, both normalised. */
export type VendorLocations = Map<string, Set<string>>;

/**
 * Does this `Vendor n` option name the same shop as a Website Used row?
 *
 * ⚠️ **Not equality.** The two databases do not spell the shops the same way: the price
 * book's options are `Guardian`, `Watsons`, `Iherb`, while Website Used calls them
 * `Guardian Pharmacy`, `Watsons Pharmacy`, `Iherb`. An `===` here silently drops every shop
 * whose name was written out in full — and a dropped shop looks exactly like an untagged
 * one, so the toggle would just quietly show fewer prices.
 *
 * Containment either way, on normalised text. Deliberately not fuzzy beyond that: with nine
 * shops, a looser rule buys nothing and risks matching `Google Search` to half of them.
 */
export function sameShop(a: string, b: string): boolean {
	const x = normTag(a);
	const y = normTag(b);
	if (!x || !y) return false;
	return x === y || x.includes(y) || y.includes(x);
}

/** Read the shop → tags map once. Everything downstream is pure. */
export async function readVendorLocations(client: Client): Promise<VendorLocations> {
	const map: VendorLocations = new Map();
	for (const page of await queryAll(client, WEBSITE_USED_DS)) {
		const props = (page as any).properties ?? {};
		const title = (Object.values(props).find((v: any) => v?.type === "title") as any)?.title ?? [];
		const name = title.map((t: any) => t.plain_text).join("").trim();
		if (!name) continue;
		const tags = new Set<string>();
		for (const v of Object.values<any>(props)) {
			if (v?.type === "multi_select") for (const o of v.multi_select ?? []) if (o?.name) tags.add(normTag(o.name));
			if (v?.type === "select" && v.select?.name) tags.add(normTag(v.select.name));
		}
		map.set(name, tags);
	}
	return map;
}

/**
 * Is this vendor somewhere you will be, in this mode?
 *
 * `cheapest` is true for everything — it is the absence of a filter, not a location.
 *
 * ⚠️ **An untagged shop is NOT at any location**, and the page says so rather than hiding
 * the row (user's call, 2026-10-04). Six of the nine shops carried no tag when this was
 * written, so "hide what isn't tagged" would have emptied the list on a missing tag and
 * looked identical to having nothing to buy.
 */
export function vendorAtLocation(locations: VendorLocations, vendor: string, mode: LocationMode): boolean {
	const want = LOCATION_TAGS[mode];
	if (!want) return true;
	const wanted = normTag(want);
	for (const [shop, tags] of locations) {
		if (sameShop(shop, vendor)) return tags.has(wanted);
	}
	return false;
}
