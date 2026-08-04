import {
	MAX_PACK_SHOTS,
	macroUserContent,
	macroUserPrompt,
	packShotsFor,
	selectPackShots,
} from "../core/macro-prompt.js";
import { resolveShengSiongPackShots, shengSiongPackShots } from "../core/stores/shengsiong-images.js";
import { check, describe, eq } from "./harness.js";

/**
 * Which pack shots get attached to a nutrition lookup — the single biggest cost
 * lever in the project, and the one most able to break without saying so.
 *
 * A back-of-pack photo turns a 29-cent, 54-second lookup into a 2.4-cent,
 * 5-second one. If `selectPackShots` quietly stops matching FairPrice's filenames
 * — they add a size variant, drop the date suffix, change a letter — every lookup
 * silently reverts to the expensive path and nothing anywhere reports it. Hence
 * the real URLs below, copied from live pages on 2026-08-04.
 */
describe("pack shots — which photos are worth attaching");

const M = "https://media.nedigital.sg/fairprice/fpol/media/images/product/XL";
const front = `${M}/47440_XL1_20260327.jpg`;
const back = `${M}/47440_BXL1_20250411.jpg`;
const left = `${M}/11838626_LXL1_20240521.jpg`;
const right = `${M}/11838626_RXL1_20240521.jpg`;
const backNoDate = `${M}/13051601_BXL1.jpg`;
const leftNoDate = `${M}/13137896_LXL1.jpg`;
const otherSkuLeft = `${M}/10966597_LXL1_20230327.jpg`;

// Real listings, exactly as FairPrice publishes them.
eq("Skippy — front + back keeps the back", selectPackShots([front, back]), [back]);
eq("Milo — back beats the side", selectPackShots([front, left, back]), [back, left]);
eq("Quaker Oats — four views capped at two", selectPackShots([front, left, right, back]), [back, left]);
eq("Greek yoghurt — back with no date suffix", selectPackShots([front, backNoDate]), [backNoDate]);
eq("Banana — side only, no date suffix", selectPackShots([front, leftNoDate]), [leftNoDate]);
eq("Tofu — front only, so nothing", selectPackShots([front]), []);
eq("Milk — side shot carries a DIFFERENT sku", selectPackShots([front, otherSkuLeft]), [otherSkuLeft]);

// ⚠️ The SKU case above is the one that looks like a bug and is not. FairPrice
// reuses one photo across a range, so "[BCRS] Farmhouse Milk - Fresh"
// (clientItemId 13281014) publishes 10966597_LXL1 as its own side view. Filtering
// these by the product's SKU — the obvious rule — throws away its only label shot.

eq("no images at all", selectPackShots([]), []);
eq("undefined images", selectPackShots(undefined), []);
eq("duplicates collapse", selectPackShots([back, back, front]), [back]);
eq("non-https is refused", selectPackShots(["http://insecure/47440_BXL1.jpg"]), []);
eq("unknown naming convention yields nothing", selectPackShots(["https://shop.example/img/back.jpg"]), []);
eq("an unknown view letter is not guessed at", selectPackShots([`${M}/47440_MXL1_2026.jpg`]), []);
eq("the /XL/ directory alone is not a view", selectPackShots(["https://media.nedigital.sg/a/XL/plain.jpg"]), []);
eq("lowercase filename still classifies", selectPackShots([`${M}/47440_bxl1_2026.jpg`]), [`${M}/47440_bxl1_2026.jpg`]);
eq("multi-digit view index", selectPackShots([`${M}/47440_BXL12_2026.jpg`]), [`${M}/47440_BXL12_2026.jpg`]);
check("the cap is two", MAX_PACK_SHOTS === 2, `MAX_PACK_SHOTS is ${MAX_PACK_SHOTS}`);

/**
 * The commodity gate on top — `packShotsFor`, which is what callers must use.
 *
 * This encodes the frozen-chicken back-fire: photos plus tools cost $0.60 against
 * $0.41 text-only and produced a 24.8 g protein outlier where ~17-18 is right,
 * because a pack with no panel leaves only marketing copy to read. Fresh food gets
 * no photographs even when the shop published a back view.
 */
describe("pack shots — the commodity gate refuses photos");

const shots = (q: Parameters<typeof packShotsFor>[0]) => packShotsFor(q).length;

eq("packaged good keeps its back shot", shots({ product: "Skippy Peanut Butter Spread - Creamy", images: [front, back] }), 1);
eq("produce is refused", shots({ product: "Agro Fresh Broccoli", categoryKey: "produce", images: [front, back] }), 0);
eq(
	"fresh chicken is refused",
	shots({ product: "Kee Song Fresh Chicken - Boneless Breast", ingredientName: "Chicken Breast", images: [front, back] }),
	0,
);
eq(
	"frozen chicken is refused",
	shots({ product: "Seara Frozen Chicken Thigh 2kg", ingredientName: "Chicken Thigh", images: [front, back] }),
	0,
);
// The narrowness of isCommodityFood must survive: a fish word with NO state word
// is a packaged good and keeps everything.
eq("canned tuna is not a commodity", shots({ product: "FairPrice Tuna Flakes - In Water", images: [front, back] }), 1);
eq("fresh milk is not a commodity", shots({ product: "[BCRS] Farmhouse Milk - Fresh", images: [front, otherSkuLeft] }), 1);
eq("commodity with no images", shots({ product: "Sumifru Sweet Mountain Bananas", categoryKey: "produce" }), 0);

/**
 * Sheng Siong's scheme — a second convention, and a very different one.
 *
 * FairPrice bakes the view into the filename; Sheng Siong numbers them `.0`, `.1`,
 * `.2` with no marker at all. Index 0 is always the front — verified 2026-08-04 by
 * looking at both: index 0 was the marketing face ("Cholesterol Free"), index 1 the
 * nutrition panel, legible and carrying its own Per-100g column.
 *
 * This matters more here than at FairPrice: Sheng Siong publishes no nutrition data
 * and `web_fetch` cannot read its pages either, so without these photos its products
 * take the ~$0.29 guess-from-a-web-search path. With them, ~$0.03.
 */
describe("pack shots — Sheng Siong's numbered scheme");

const SS = "https://ssecomm.s3.ap-southeast-1.amazonaws.com/products/lg";
const KEY = "qmuntLDsvIewDRGoQl2yWBoTTNqsxB";

eq("three images built from key + count", shengSiongPackShots(KEY, 3), [
	`${SS}/${KEY}.0.jpg`,
	`${SS}/${KEY}.1.jpg`,
	`${SS}/${KEY}.2.jpg`,
]);
eq("the front is built but never selected", selectPackShots(shengSiongPackShots(KEY, 3)), [
	`${SS}/${KEY}.1.jpg`,
	`${SS}/${KEY}.2.jpg`,
]);
eq("a single-image product yields no label shot", selectPackShots(shengSiongPackShots(KEY, 1)), []);
eq("index 1 outranks index 2", selectPackShots(shengSiongPackShots(KEY, 3), 1), [`${SS}/${KEY}.1.jpg`]);

// ⚠️ totalImg is load-bearing: an index past the end returns 403, not 404, and an
// unreachable image fails the whole API request rather than being skipped.
eq("no count means no urls", shengSiongPackShots(KEY, 0), []);
eq("a missing count means no urls", shengSiongPackShots(KEY, undefined), []);
eq("a missing key means no urls", shengSiongPackShots("", 3), []);
// The key lands in a URL path, so anything but the opaque token is refused — a
// stray slash or dot would silently address a different object.
eq("a key with a path separator is refused", shengSiongPackShots("ab/../c", 3), []);
eq("a key with a dot is refused", shengSiongPackShots("abc.0", 3), []);

// The probe short-circuits on a key it can't use, so a malformed one costs no
// network at all. (The probing itself needs the live bucket and is checked by hand
// — verified 2026-08-04: totalImg 3 → indices [0,1,2], totalImg 2 → [0,1], and an
// unknown key → [0] alone, each in under two seconds.)
check("a refused key costs no request", (await resolveShengSiongPackShots("ab/../c")).length === 0);

// Both schemes must coexist: a mixed list is ranked without either one poisoning
// the other, which is what will happen the day a third store arrives.
eq(
	"the two conventions coexist",
	selectPackShots([front, back, `${SS}/${KEY}.0.jpg`, `${SS}/${KEY}.1.jpg`], 4),
	[back, `${SS}/${KEY}.1.jpg`],
);

/** The wire shape both transports send, and the prompt that must agree with it. */
describe("pack shots — the user turn");

const withShots = macroUserContent({ product: "Skippy Peanut Butter", images: [front, back] });
const noShots = macroUserContent({ product: "Fortune Japanese Silken Tofu", images: [front] });
const shape = (c: unknown[]) => c.map((b) => (b as { type: string }).type).join("+");

eq("images come before the text", shape(withShots), "image+text");
eq("front-only degrades to text alone", shape(noShots), "text");
check(
	"the image block is a url source",
	(withShots[0] as any).source?.type === "url" && (withShots[0] as any).source?.url === back,
);
check("the prompt mentions photos when attached", /photograph/.test(macroUserPrompt({ product: "x", images: [front, back] })));
check("the prompt is silent when there are none", !/photograph/.test(macroUserPrompt({ product: "x", images: [front] })));

// A refused commodity must not be PROMISED photographs either — the prompt and the
// content array have to agree, or the model is told to read a label it wasn't given.
const commodityQ = { product: "Seara Frozen Chicken Thigh", ingredientName: "Chicken Thigh", images: [front, back] };
check("a refused commodity's prompt mentions no photos", !/photograph/.test(macroUserPrompt(commodityQ)));
check("a refused commodity still says it has no tools", /NO search or fetch tools/.test(macroUserPrompt(commodityQ)));
eq("a refused commodity sends text only", shape(macroUserContent(commodityQ)), "text");
