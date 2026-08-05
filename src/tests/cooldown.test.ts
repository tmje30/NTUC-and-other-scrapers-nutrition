import { planCooldown, NO_USAGE_COOLDOWN_DAYS, WEEKLY_BUY_COOLDOWN_DAYS } from "../core/cooldown.js";
import { check, describe, eq } from "./harness.js";

/**
 * How long a Buy buys silence for.
 *
 * ⚠️ This is the arithmetic that decides whether you are shown an item again, and
 * every way it can be wrong is quiet. Too long and a staple simply stops appearing
 * — there is no error, no banner, just an item that never comes back and nobody
 * notices for a month. Too short and the page nags about something already in the
 * cupboard. Neither announces itself, which is the same family as the 32 g serving
 * read as 100 g.
 *
 * The `Weekly Buy` route (added 2026-08-05) is the newest and the easiest to get
 * subtly wrong, because the bug is not "it threw" — it is "the pack size won", and
 * a 46-day silence on bananas looks like a perfectly ordinary cooldown in the JSON.
 */
describe("cooldown — how long a buy stays quiet");

const now = new Date("2026-08-05T00:00:00.000Z");

// The user's own worked example, and the reason the 25% haircut exists: 1 kg of
// garlic at 500 g/month is 2 months of cover, less a quarter, = 46 days.
eq("1kg at 500g/month → 46 days", planCooldown(1000, 500, now).days, 46);

// Outside the plan there is no usage to divide by.
eq("no monthly usage → the flat fallback", planCooldown(1000, 0, now).days, NO_USAGE_COOLDOWN_DAYS);
eq("no pack size → the flat fallback", planCooldown(null, 500, now).days, NO_USAGE_COOLDOWN_DAYS);

describe("cooldown — Weekly Buy ignores the pack size");

// The whole point of the tag: bananas are a weekly shop whether you came home with
// three or a dozen, so the pack must not lengthen the silence.
const small = planCooldown(200, 1000, now, { weeklyBuy: true });
const large = planCooldown(5000, 1000, now, { weeklyBuy: true });

eq("a small buy is 5 days", small.days, WEEKLY_BUY_COOLDOWN_DAYS);
eq("a large buy is also 5 days", large.days, WEEKLY_BUY_COOLDOWN_DAYS);
check("the pack size changes nothing at all", small.days === large.days && small.basis === large.basis);

// ⚠️ The regression this guards. Untagged, that 5 kg buy against 1 kg/month is
// nearly four months of silence — a weekly item gone until December. If the tag is
// ever checked AFTER the pack sum, this is the case that catches it.
check("untagged, the same buy would be far longer", planCooldown(5000, 1000, now).days > 100);

// The tag also has to beat the *fallback*, not just the sum: a weekly item outside
// the plan has no usage figure, and 14 days is still twice too long for bananas.
eq(
	"it wins over the no-usage fallback too",
	planCooldown(null, 0, now, { weeklyBuy: true }).days,
	WEEKLY_BUY_COOLDOWN_DAYS,
);

// The basis string is what the JSON shows a human reading `data/cooldowns.json`
// months later, so it has to say which route was taken.
check("the basis names the tag", small.basis.includes("weekly buy"));
check("and says the pack was ignored", small.basis.includes("ignored"));

// `until` must actually move — a plan that reports 5 days but expires now would
// suppress nothing.
eq(
	"until is 5 days out",
	new Date(small.until).getTime() - now.getTime(),
	WEEKLY_BUY_COOLDOWN_DAYS * 86_400_000,
);

// volumetric is display-only and must not disturb the tag's route.
eq(
	"a volumetric weekly item is still 5 days",
	planCooldown(2000, 1000, now, { weeklyBuy: true, volumetric: true }).days,
	WEEKLY_BUY_COOLDOWN_DAYS,
);

// Absent means "not tagged" — an old payload from a page built before the field
// existed must take the ordinary route rather than throwing or defaulting to 5.
eq("no flag at all takes the pack route", planCooldown(1000, 500, now, {}).days, 46);
