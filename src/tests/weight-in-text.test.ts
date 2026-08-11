import { check, describe, eq } from "./harness.js";
import { parseWeightInText } from "../core/stores/weight.js";

/**
 * Reading a pack weight out of a shop's product title.
 *
 * This is the second place a By-Unit row's weight may be written (the first is
 * the row's own `Name`), and the figure it produces goes straight into
 * `baselinePer100g` — it divides a real price. A wrong answer here is not a
 * missing card, it is every deal for that ingredient judged against a number no
 * shop ever charged.
 *
 * ⚠️ Half of these cases are about what must NOT parse. `parseWeight`'s unit
 * alternation ends in a bare `l`, so on free text "2 large" is two litres and
 * "3 lean chicken" is three. That never mattered while it only ever saw pack
 * labels; it matters the moment it is pointed at a title someone typed.
 */
describe("weight in text — a title is not a pack label");

const grams = (s: string) => parseWeightInText(s)?.grams ?? null;

eq("a plain weight in a title", grams("Fresh Eggs (10s) 550g"), 550);
eq("kg", grams("Kampong Chicken Whole 1.5kg"), 1500);
eq("a volume, and it knows it is one", parseWeightInText("Fresh Milk 1L"), { grams: 1000, volumetric: true });
eq("a multipack beats the single size", grams("Pu Erh Tea Bags 100 x 2g"), 200);
eq("thousands separator", grams("Rice 1,500g"), 1500);

// ⚠️ The reason this function exists at all.
eq("⚠️ '2 large' is NOT two litres", grams("Eggs 2 large"), null);
eq("⚠️ '3 lean' is NOT three litres", grams("Chicken Breast 3 lean cuts"), null);
eq("a bare count is not a weight", grams("Razor Cartridge Refill - Hydro 5"), null);
eq("plies are not litres", grams("Bathroom Tissue Roll - 4 Ply"), null);
eq("nothing at all", grams("Chicken Soup Cube"), null);
eq("empty input", grams(""), null);

// A piece count and a weight can sit in the same title; the weight is the one
// this reads, because the count is already in `Size[Vendor n]`.
eq("count and weight together", grams("Fresh Eggs 10s 550g"), 550);

check("null is returned, never zero", parseWeightInText("Soup Cube") === null);
