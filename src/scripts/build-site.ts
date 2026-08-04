import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@notionhq/client";
import { runOnce } from "../core/run.js";
import { renderDealsPage } from "../core/site.js";
import { resolveShengSiongPackShots } from "../core/stores/shengsiong-images.js";
import { renderHistoryPage } from "../core/history.js";
import { readParkedIngredients, type ParkedIngredient } from "../core/notion.js";
import { readPurchases } from "../core/purchases-file.js";
import { readExclusions } from "../core/exclusions-file.js";
import { config } from "../core/config.js";

/**
 * Runs the scan and writes the GitHub Pages site:
 *   public/index.html  — the styled deals page
 *   public/summary.json — { count } for the notify step
 * The workflow deploys public/ to Pages, then runs notify.ts.
 */

const {
	planDeals,
	otherDeals,
	targetsConsidered,
	searchTerms,
	reviews,
	recommendations,
	snoozed,
	shengsiong,
	errors,
} = await runOnce();

/**
 * A shop missing from today's scan. Says how old the data is rather than just
 * "missing", because one stale day is a hiccup and four is a runner that has
 * stopped — and the difference decides whether you go and look at it.
 */
const warning = (() => {
	if (!shengsiong || shengsiong.fresh) return undefined;
	const age =
		shengsiong.staleDays == null
			? "no data has ever arrived"
			: shengsiong.staleDays === 1
				? "yesterday's data is the latest"
				: `the latest data is ${shengsiong.staleDays} days old`;
	return `Sheng Siong is missing from this scan — ${age}. FairPrice prices only.`;
})();
const total = planDeals.length + otherDeals.length;
console.error(
	`Main plan: ${targetsConsidered} targets → ${planDeals.length} plan + ${otherDeals.length} other deals` +
		(errors.length ? `, ${errors.length} store errors` : ""),
);
if (snoozed.length) {
	console.error(`${snoozed.length} recently bought, not searched:`);
	for (const s of snoozed) console.error(`  ${s.name} — back ${s.until.slice(0, 10)}`);
}
if (reviews.length) {
	console.error(`${reviews.length} borderline (review-band) near-misses — not published:`);
	for (const r of reviews.slice(0, 12)) {
		console.error(`  ${r.target} ≈ ${r.store} · ${r.product} (${r.score.toFixed(2)})`);
	}
}
if (errors.length) {
	const byStore = new Map<string, { count: number; sample: string }>();
	for (const e of errors) {
		const cur = byStore.get(e.store) ?? { count: 0, sample: e.message };
		byStore.set(e.store, { count: cur.count + 1, sample: cur.sample });
	}
	for (const [store, { count, sample }] of byStore) {
		console.error(`  ${store}: ${count} errors — e.g. "${sample}"`);
	}
}

/**
 * Give the Sheng Siong products on this page their pack shots.
 *
 * FairPrice hands over a finished `images` list in its search payload, so its cards
 * need nothing here. Sheng Siong gives an `imageKey` and no count, and guessing the
 * count means a 403 that fails the whole lookup — so the count is established by
 * asking the bucket. See `resolveShengSiongPackShots`.
 *
 * Done HERE, after the deals are chosen, and not in the store module: the scan
 * returns well over a thousand products and about two dozen reach the page. Probing
 * at scan time would be fifty times the requests for the same answer.
 *
 * Entirely best-effort. Every failure path resolves to no images, which is the
 * text-only lookup this had before — a page must never fail to build over a
 * photograph.
 */
async function attachShengSiongPackShots(): Promise<void> {
	const products = [
		...planDeals.map((d) => d.product),
		...otherDeals.map((d) => d.product),
		...recommendations.map((r) => r.product),
	].filter((p) => p && p.store === "Sheng Siong" && p.imageKey && !p.images?.length);
	if (!products.length) return;

	// One key can back several cards (the same product matching two ingredients), so
	// probe each key once and share the answer.
	const byKey = new Map<string, typeof products>();
	for (const p of products) {
		const k = String(p.imageKey);
		byKey.set(k, [...(byKey.get(k) ?? []), p]);
	}

	const resolved = await Promise.all(
		[...byKey.keys()].map(async (key) => [key, await resolveShengSiongPackShots(key)] as const),
	);
	let withShots = 0;
	for (const [key, urls] of resolved) {
		for (const p of byKey.get(key) ?? []) p.images = urls;
		if (urls.length > 1) withShots++;
	}
	console.error(
		`Sheng Siong pack shots: ${withShots}/${byKey.size} products have a back-of-pack photo.`,
	);
}

try {
	await attachShengSiongPackShots();
} catch (e) {
	console.error(`Sheng Siong pack shots failed — ${(e as Error).message}. Building without them.`);
}

await mkdir("public", { recursive: true });
await writeFile(
	"public/index.html",
	renderDealsPage(planDeals, otherDeals, new Date(), recommendations, {
		repo: config.repo(),
		addEndpoint: config.addEndpoint(),
		snoozed,
		warning,
	}),
	"utf8",
);
await writeFile(
	"public/summary.json",
	JSON.stringify({
		count: total,
		planCount: planDeals.length,
		otherCount: otherDeals.length,
		generatedAt: new Date().toISOString(),
		warning,
		shengsiong,
	}),
	"utf8",
);
if (warning) console.error(`Warning: ${warning}`);
console.error(`Wrote public/index.html (${total} deals) and public/summary.json`);

/**
 * The history page — parked ingredients, what's been bought, the never-buy list.
 *
 * Wrapped in its own try so it can never take the deals page down with it: the
 * deals page is the one the daily Telegram message links to, and a Notion hiccup
 * while listing parked rows is not a reason for the user to get a broken link at
 * 06:00. A failed parked read still renders the page — it just says so, rather
 * than showing an empty section that reads as "nothing is parked".
 */
try {
	let parked: ParkedIngredient[] = [];
	let parkedError: string | undefined;
	try {
		parked = await readParkedIngredients(new Client({ auth: config.notionToken() }));
	} catch (e: any) {
		parkedError = e.message;
		console.error(`Warning: could not read parked ingredients: ${e.message}`);
	}

	const purchases = await readPurchases();
	const exclusions = await readExclusions();

	await writeFile(
		"public/history.html",
		renderHistoryPage({
			repo: config.repo(),
			addEndpoint: config.addEndpoint(),
			parked,
			purchases,
			exclusions,
			parkedError,
		}),
		"utf8",
	);
	const open = purchases.entries.filter((e) => e.outcome === "open").length;
	console.error(
		`Wrote public/history.html (${parked.length} parked, ${open} to file, ` +
			`${purchases.entries.length} purchases logged)`,
	);
} catch (e: any) {
	console.error(`Warning: failed to write public/history.html: ${e.message}`);
}

// Publish the search terms so residential runners (phone/laptop) can fetch them
// without a Notion token. Wrapped so a failure here never breaks the page/notify.
try {
	await writeFile(
		"public/targets.json",
		JSON.stringify({ generatedAt: new Date().toISOString(), terms: searchTerms }),
		"utf8",
	);
	console.error(`Wrote public/targets.json (${searchTerms.length} terms)`);
} catch (e: any) {
	console.error(`Warning: failed to write public/targets.json: ${e.message}`);
}
