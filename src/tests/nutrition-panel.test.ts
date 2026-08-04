import { parseNutritionPanel } from "../core/nutrition-panel.js";
import { check, describe, eq } from "./harness.js";

/**
 * The shop's own nutrition table → per-100g figures.
 *
 * ⚠️ **Every panel measured is PER SERVING, never per 100g** — real servings seen
 * were 32 g, 35 g, 236 ml and 100 g. A 32 g peanut-butter serving read as 100 g is
 * wrong by more than 3×, and wrong in the direction that looks entirely plausible:
 * nothing is missing, no error is raised, and the number quietly poisons every plan
 * formula built on it. That is the whole reason this file exists.
 *
 * The parser's other job is refusing. A blank set of boxes sends the user to the
 * paid lookup, which is a fine outcome; wrong numbers in the boxes are not.
 */
describe("nutrition panel — scaling and refusal");

/** Build a panel the way FairPrice ships them: a header row, then label/value rows. */
const table = (header: string[], rows: [string, string][]) =>
	`<table><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr>` +
	rows.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join("") +
	`</table>`;

const skippy = table(
	["Per Serving (32g)", ""],
	[
		["Energy", "190kcal"],
		["Protein", "7.3g"],
		["Total Fat", "16.5g"],
		["- Saturated Fat", "3.4g"],
		["- Trans Fat", "0g"],
		["Carbohydrate", "5.4g"],
		["- Added Sugars", "2.6g"],
		["Dietary Fibre", "1.7g"],
		["Sodium", "125mg"],
	],
);

const p = parseNutritionPanel(skippy);
check("a 32 g serving parses", p != null);
eq("protein scaled 32g → 100g", p?.proteinPer100g, 22.81);
eq("fat scaled", p?.fatsPer100g, 51.56);
eq("carbs scaled", p?.carbsPer100g, 16.88);
eq("fibre scaled", p?.fiberPer100g, 5.31);
eq("the serving is recorded", p?.servingG, 32);
check("the basis names the serving", /32 g/.test(p?.basis ?? ""), p?.basis);

// ⚠️ The sub-row traps. "- Saturated Fat" is a component OF total fat and
// "- Added Sugars" of carbohydrate; a substring match for "fat" or "sugar" takes
// whichever comes first and double-counts or reports the wrong row entirely.
check("saturated fat was not taken for total fat", p?.fatsPer100g !== Math.round((3.4 * 100) / 32 * 100) / 100);
check("added sugars was not taken for carbohydrate", p?.carbsPer100g !== Math.round((2.6 * 100) / 32 * 100) / 100);

// Energy and sodium must be ignored: one is not a mass, the other is not a macro.
// `grams()` returning null for kcal is how that happens without naming them.
const noSodium = parseNutritionPanel(table(["Per Serving (100g)", ""], [["Sodium", "125mg"]]));
eq("a panel of nothing but sodium establishes nothing", noSodium, null);

describe("nutrition panel — column choice");

const bothCols =
	`<table><tr><th>Nutrient</th><th>Per Serving (35g)</th><th>Per 100 g</th></tr>` +
	`<tr><td>Protein</td><td>3.5g</td><td>10g</td></tr>` +
	`<tr><td>Total Fat</td><td>1.4g</td><td>4g</td></tr></table>`;
const bf = parseNutritionPanel(bothCols);
eq("a real per-100g column wins over scaling", bf?.proteinPer100g, 10);
eq("and needs no scaling", bf?.servingG, 100);
check("the basis says so", /per-100g/.test(bf?.basis ?? ""), bf?.basis);

// The serving sometimes sits in the FIRST header cell — the row-label heading —
// rather than over a value column. The fallback that handles this needs a header
// with at least two cells to know which column the values are in; a single-cell
// header is genuinely ambiguous and is refused, which is correct.
const firstCell = `<table><tr><th>Per Serving (35g)</th><th>Amount</th></tr><tr><td>Protein</td><td>3.5g</td></tr></table>`;
eq("serving stated in the row-label heading", parseNutritionPanel(firstCell)?.proteinPer100g, 10);
eq(
	"a single-cell header is too ambiguous to scale",
	parseNutritionPanel(`<table><tr><th>Per Serving (35g)</th></tr><tr><td>Protein</td><td>3.5g</td></tr></table>`),
	null,
);

describe("nutrition panel — units and refusals");

eq("ml is treated as g", parseNutritionPanel(table(["Per Serving (236ml)", ""], [["Protein", "8g"]]))?.proteinPer100g, 3.39);
eq("litres scale up", parseNutritionPanel(table(["Per Serving (1L)", ""], [["Protein", "30g"]]))?.proteinPer100g, 3);
eq("mg converts down", parseNutritionPanel(table(["Per 100g", ""], [["Protein", "500mg"]]))?.proteinPer100g, 0.5);

// ⚠️ Refusing is a feature. An unstated serving size cannot be scaled, and guessing
// 100 g is exactly the 3× error this parser exists to prevent.
eq("no serving size stated → null", parseNutritionPanel(table(["Amount", ""], [["Protein", "7.3g"]])), null);
eq("no table at all → null", parseNutritionPanel("<p>Nutrition information unavailable</p>"), null);
eq("empty string → null", parseNutritionPanel(""), null);
eq("a header with no rows → null", parseNutritionPanel("<table><tr><th>Per 100g</th></tr></table>"), null);
eq("nothing matched → null", parseNutritionPanel(table(["Per 100g", ""], [["Calcium", "120mg"]])), null);

// The same per-100g plausibility gate as the model path: protein + fat + carbs
// cannot exceed 100 g in 100 g of food. A total in the 130s means the serving was
// misread, which is the failure that would otherwise look fine.
const impossible = table(["Per Serving (10g)", ""], [
	["Protein", "7g"],
	["Total Fat", "5g"],
	["Carbohydrate", "6g"],
]);
eq("figures that exceed 100 g per 100 g are rejected wholesale", parseNutritionPanel(impossible), null);
