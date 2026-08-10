import { parseItem, parseList, sizeLabel, splitLines } from "../core/list-parse.js";
import { check, describe, eq } from "./harness.js";

/**
 * The quantity grammar of a texted grocery list.
 *
 * ⚠️ **The case this suite exists for is the size/count confusion.** `2kg
 * chicken` is one thing weighing two kilos and `chicken x2` is two things — they
 * land in different Notion columns, and reading one as the other is silent: the
 * row appears, it looks filled in, and it says you want two kilograms of a thing
 * you wanted two of. Every assertion below that checks BOTH `count` and
 * `amountG` on one line is guarding that boundary, not being thorough for its
 * own sake.
 */
describe("texted list — quantities");

const p = (s: string) => parseItem(s)!;

eq("a bare name is one of it", p("milk"), {
	raw: "milk",
	name: "milk",
	count: 1,
	amountG: null,
	volumetric: false,
});

const chicken = p("2kg chicken breast");
eq("a leading weight is a SIZE, not a count — name", chicken.name, "chicken breast");
eq("a leading weight is a SIZE, not a count — count stays 1", chicken.count, 1);
eq("a leading weight is a SIZE, not a count — 2kg is 2000g", chicken.amountG, 2000);
eq("a weight is not volumetric", chicken.volumetric, false);

const milk = p("1L milk");
eq("a leading volume — name", milk.name, "milk");
eq("a leading volume — 1L is 1000", milk.amountG, 1000);
eq("a leading volume sets volumetric", milk.volumetric, true);

eq("ml stays ml", p("750ml fish sauce").amountG, 750);
eq("ml is volumetric", p("750ml fish sauce").volumetric, true);

const bananas = p("bananas x6");
eq("a trailing xN is a COUNT — name", bananas.name, "bananas");
eq("a trailing xN is a COUNT — count", bananas.count, 6);
eq("a trailing xN is a COUNT — no size invented", bananas.amountG, null);

eq("a leading N x is the same count", p("3 x eggs").count, 3);
eq("a leading N x leaves a clean name", p("3 x eggs").name, "eggs");

const pb = p("2 x 500g peanut butter");
eq("count and size together — name", pb.name, "peanut butter");
eq("count and size together — count", pb.count, 2);
eq("count and size together — size", pb.amountG, 500);

eq("a leading bare integer is a count", p("2 milk").count, 2);
eq("a leading bare integer leaves the name", p("2 milk").name, "milk");

eq("a small trailing integer is a count", p("eggs 30").count, 30);
eq("a small trailing integer leaves the name", p("eggs 30").name, "eggs");

// 600 loaves of bread is the failure this cap exists for — see MAX_BARE_COUNT.
eq("a LARGE trailing integer is not a count", p("bread 600").count, 1);
eq("a LARGE trailing integer stays in the name", p("bread 600").name, "bread 600");

eq("dash bullet stripped", p("- rice").name, "rice");
eq("star bullet stripped", p("* rice").name, "rice");
eq("numbered bullet stripped", p("1. rice").name, "rice");
// "1 rice" is NOT numbering — no punctuation — so it means one of them.
eq("a bare 1 is a count, not numbering", p("1 rice").count, 1);
eq("a bare 1 leaves the name", p("1 rice").name, "rice");

eq("decimal sizes parse", p("1.5kg flour").amountG, 1500);
eq("comma decimal sizes parse", p("1,5kg flour").amountG, 1500);

eq("'grams' beats 'g'", p("500 grams rice").amountG, 500);
eq("'litres' beats 'l'", p("2 litres milk").amountG, 2000);
eq("'litres' is volumetric", p("2 litres milk").volumetric, true);

const mid = p("peanut butter 500g smooth");
eq("a size mid-line is found", mid.amountG, 500);
eq("a size mid-line is removed from the name", mid.name, "peanut butter smooth");

// "3in1" must not be read as 3 (in). Stemming "3 in 1" is the same trap that
// made a one-word exclusion ban most of the shop — see exclusions.ts.
eq("a number inside a word is not a size", p("3in1 coffee").amountG, null);

eq("decoration alone parses to nothing", parseItem("- "), null);
eq("whitespace alone parses to nothing", parseItem("   "), null);
eq("a bare number alone parses to nothing", parseItem("42"), null);

describe("texted list — splitting a message");

const multi = splitLines("Onion (White), Fresh\nMilk");
eq("newlines win when there is more than one line", multi.length, 2);
// The comma inside the user's own naming standard must survive.
eq("a comma inside a name is not a split", multi[0], "Onion (White), Fresh");

eq("a single line splits on commas", splitLines("milk, eggs, rice").length, 3);
eq("blank lines are dropped", splitLines("milk\n\n\neggs").length, 2);

const whole = parseList("2kg chicken breast\n1L milk\nbananas x6\n- harissa paste");
eq("a whole message parses end to end", whole.length, 4);
eq("…line 1 keeps its size", whole[0].amountG, 2000);
eq("…line 2 keeps its volumetric flag", whole[1].volumetric, true);
eq("…line 3 keeps its count", whole[2].count, 6);
eq("…line 4 keeps its name", whole[3].name, "harissa paste");

describe("texted list — size labels");

eq("grams label", sizeLabel(p("500g rice")), "500g");
eq("kg label", sizeLabel(p("1.5kg rice")), "1.5kg");
eq("ml label", sizeLabel(p("750ml sauce")), "750ml");
eq("L label", sizeLabel(p("2L milk")), "2L");
eq("no size, no label", sizeLabel(p("rice")), undefined);
