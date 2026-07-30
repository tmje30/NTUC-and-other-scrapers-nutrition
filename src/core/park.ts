import { Client } from "@notionhq/client";
import { INGREDIENTS_DS, PARKED_TAG, TAGS_PROPERTY } from "./notion.js";

/**
 * Parking an ingredient: the page's "Not in use" button, which tags the Notion
 * row `Not in Use ATM` so `readGroceryTargets` stops searching for it.
 *
 * Two rules this module exists to enforce:
 *
 *  1. **The tag is ADDED, never assigned.** A multi_select write replaces the
 *     whole list, so the existing tags have to be read and sent back or they're
 *     silently destroyed — and those tags (Brand Specific, Quality item,
 *     Organic/animal welfare) are the ingredient's search configuration. Losing
 *     them means an item that comes back later comes back wrong.
 *
 *  2. **No schema is created.** Writing an unknown name into a multi_select makes
 *     Notion invent the option, which is a schema edit to a live personal
 *     workspace. So the option is verified against the data source first, and a
 *     missing one is a hard error telling the user to add it themselves rather
 *     than something this code quietly fixes.
 */

export interface ParkResult {
	/** The row's tags after the write (or as found, when already parked). */
	tags: string[];
	/** True when the tag was already there and nothing was written. */
	alreadyParked: boolean;
}

/** The tag option, exactly as the data source spells it. Throws if absent. */
async function parkedOption(client: Client): Promise<string> {
	const ds = (await client.dataSources.retrieve({ data_source_id: INGREDIENTS_DS })) as any;
	const def = ds.properties?.[TAGS_PROPERTY];
	if (def?.type !== "multi_select") {
		throw new Error(`Ingredients has no multi-select "${TAGS_PROPERTY}" property`);
	}
	const options: string[] = (def.multi_select.options ?? []).map((o: any) => o.name);
	const match = options.find((o) => o.toLowerCase() === PARKED_TAG.toLowerCase());
	if (!match) {
		throw new Error(
			`the "${TAGS_PROPERTY}" property has no "${PARKED_TAG}" option — ` +
				`add it in Notion first (this tool will not create it). Found: ${options.join(", ")}`,
		);
	}
	return match;
}

/**
 * Add the parked tag to one ingredient row, preserving its other tags. Idempotent:
 * a row that already carries the tag is left untouched and reported as such.
 */
export async function parkIngredient(
	client: Client,
	ingredientId: string,
	dryRun = false,
): Promise<ParkResult> {
	if (!ingredientId) throw new Error("park needs an ingredientId");
	const option = await parkedOption(client);

	const page = (await client.pages.retrieve({ page_id: ingredientId })) as any;
	const current: string[] = (page.properties?.[TAGS_PROPERTY]?.multi_select ?? [])
		.map((o: any) => o.name)
		.filter(Boolean);

	if (current.some((t) => t.toLowerCase() === option.toLowerCase())) {
		return { tags: current, alreadyParked: true };
	}

	const tags = [...current, option];
	if (!dryRun) {
		await client.pages.update({
			page_id: ingredientId,
			properties: { [TAGS_PROPERTY]: { multi_select: tags.map((name) => ({ name })) } },
		} as any);
	}
	return { tags, alreadyParked: false };
}
