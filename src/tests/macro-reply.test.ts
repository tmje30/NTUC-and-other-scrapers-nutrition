import { isCommodityFood, macroToolsFor, parseMacroReply } from "../core/macro-prompt.js";
import { check, describe, eq } from "./harness.js";

/**
 * The model's reply → four numbers, or null.
 *
 * Null is the important half. Every failure path here writes the row WITHOUT
 * nutrition, which is always better than writing numbers nobody checked — a macro
 * lookup must never lose an add, and it must never invent a figure either.
 */
describe("macro reply — parsing");

const block = (o: Record<string, unknown>) => "Here is what I found.\n\n```json\n" + JSON.stringify(o) + "\n```";
const good = {
	proteinPer100g: 22.8,
	fatsPer100g: 51.6,
	carbsPer100g: 16.9,
	fiberPer100g: 5.2,
	source: "product-page",
	basis: "Skippy Creamy, as sold",
};

const r = parseMacroReply(block(good));
eq("protein", r?.proteinPer100g, 22.8);
eq("source is kept", r?.source, "product-page");
eq("basis is kept", r?.basis, "Skippy Creamy, as sold");
check("the note describes the source", /product page/.test(r?.note ?? ""), r?.note);

// ⚠️ The LAST fenced block wins — the model often quotes the label it read earlier
// in the reply, and that earlier block is per-serving.
const two = "```json\n" + JSON.stringify({ ...good, proteinPer100g: 7.3 }) + "\n```\n\nRescaled:\n\n" + "```json\n" + JSON.stringify(good) + "\n```";
eq("the last json block wins", parseMacroReply(two)?.proteinPer100g, 22.8);

eq("no json block at all → null", parseMacroReply("I could not find anything for this product."), null);
eq("malformed json → null", parseMacroReply("```json\n{ not json }\n```"), null);
eq(
	"all four null → null",
	parseMacroReply(block({ proteinPer100g: null, fatsPer100g: null, carbsPer100g: null, fiberPer100g: null, source: "generic", basis: "x" })),
	null,
);

// A partial answer is still an answer: each column is independent, so protein and
// fat without fibre writes the two it has.
const partial = parseMacroReply(block({ proteinPer100g: 20, fatsPer100g: 3, carbsPer100g: null, fiberPer100g: null, source: "search", basis: "x" }));
check("a partial answer survives", partial != null);
eq("and keeps its nulls", partial?.fiberPer100g, null);

describe("macro reply — the sanity gates");

// ⚠️ The single likeliest way this goes wrong: per-serving figures reported as
// per-100g. Protein + fat + carbs cannot exceed 100 g in 100 g of food.
eq(
	"protein + fat + carbs over 105 g is rejected wholesale",
	parseMacroReply(block({ ...good, proteinPer100g: 40, fatsPer100g: 60, carbsPer100g: 35 })),
	null,
);
// Slack for rounding and for labels that count fibre inside carbohydrate.
check("but 100 g exactly is accepted", parseMacroReply(block({ ...good, proteinPer100g: 40, fatsPer100g: 40, carbsPer100g: 20 })) != null);

// Individual figures outside 0-100 g are dropped rather than failing the answer.
eq("a figure over 100 g is dropped", parseMacroReply(block({ ...good, fiberPer100g: 150 }))?.fiberPer100g, null);
eq("a negative figure is dropped", parseMacroReply(block({ ...good, fiberPer100g: -3 }))?.fiberPer100g, null);
eq("a numeric string is accepted", parseMacroReply(block({ ...good, fiberPer100g: "5.2" }))?.fiberPer100g, 5.2);

eq("an unknown source falls back to generic", parseMacroReply(block({ ...good, source: "vibes" }))?.source, "generic");
eq("a missing basis is labelled", parseMacroReply(block({ ...good, basis: "" }))?.basis, "unspecified");
check(
	"searches are reported in the note",
	/2 searches/.test(parseMacroReply(block({ ...good, source: "search" }), 2)?.note ?? ""),
);
check(
	"a generic answer says so",
	/generic values/.test(parseMacroReply(block({ ...good, source: "generic" }))?.note ?? ""),
);

/**
 * The commodity gate — which foods skip the web search entirely.
 *
 * Measured 2026-08-04: four lookups on frozen chicken thigh cost $0.38-0.60 each,
 * landed on `generic` every time, and disagreed with themselves (16.6, 16.7, 17
 * and 24.8 g protein, where ~17-18 is right). Sending no tools gives $0.003 in
 * 2.5s with a better answer. The gate is NARROW on purpose — "no label" is not the
 * same as the category — and this suite is what keeps it narrow.
 */
describe("commodity gate — narrow on purpose");

const c = (product: string, over: Record<string, unknown> = {}) => isCommodityFood({ product, ...over });

check("produce category", c("Anything", { categoryKey: "produce" }));
check("fresh chicken breast", c("Kee Song Fresh Chicken - Boneless Breast"));
check("frozen chicken thigh", c("Seara Frozen Chicken Thigh 2kg"));
check("chilled salmon fillet", c("Chilled Norwegian Salmon Fillet"));
check("raw prawns", c("Raw Prawns - Deveined"));
check("live clams", c("Live Clams"));
check("fresh eggs", c("Pasar Fresh Eggs"));
check("the state can come from the ingredient name", c("Chicken Thigh 2kg", { ingredientName: "Frozen chicken" }));

// ⚠️ These must all stay OUT. A meat or fish word alone is not enough — the state
// word is what separates unlabelled fresh food from a packaged good whose panel is
// findable and worth paying for.
check("canned tuna keeps its tools", !c("FairPrice Tuna Flakes - In Water"));
check("greek yoghurt keeps its tools", !c("Emmi Swiss Premium Greek Style Yogurt"));
check("peanut butter keeps its tools", !c("Skippy Peanut Butter Spread - Creamy"));
check("instant oats keeps its tools", !c("Quaker Oats Instant Oatmeal"));
check("chicken stock keeps its tools", !c("Knorr Chicken Stock Cubes"));
check("fish sauce keeps its tools", !c("Tiparos Fish Sauce"));
check("a fresh-sounding non-food word is not enough", !c("Fresh Milk"));

eq("a commodity gets no tools", macroToolsFor({ product: "Agro Fresh Broccoli", categoryKey: "produce" }).length, 0);
check("everything else gets the full set", macroToolsFor({ product: "Skippy Peanut Butter" }).length > 0);
