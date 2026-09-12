import { mkdir, writeFile } from "node:fs/promises";
import { Client } from "@notionhq/client";
import { config } from "../core/config.js";
import { readGroceryList, totals } from "../core/grocery-page.js";
import { renderListPage } from "../core/grocery-page-render.js";

/**
 * Writes `public/list.html` — the shopping page. Standalone so it can be run on its own
 * (`npm run build-list`) without the daily scan, which takes minutes and touches every
 * shop; this needs Notion and nothing else.
 *
 * `build-site.ts` calls the same two functions inline, so the daily deploy publishes the
 * page as part of one `public/` directory. Running this by hand is for previewing.
 *
 * Usage:
 *   npm run build-list
 */

await mkdir("public", { recursive: true });

const client = new Client({ auth: config.notionToken() });
const rows = await readGroceryList(client);
const open = rows.filter((r) => !r.ticked);
const t = totals(open);

await writeFile(
	"public/list.html",
	renderListPage(rows, {
			repo: config.repo(),
			listEndpoint: config.listEndpoint(),
			listSecret: config.listSecret(),
			siteUrl: config.siteUrl(),
			generatedAt: new Date(),
		}),
	"utf8",
);

console.error(
	`Wrote public/list.html — ${open.length} to buy (${rows.length - open.length} already ticked in Notion), ` +
		`$${t.full.toFixed(2)} full / $${t.discounted.toFixed(2)} with discounts` +
		(t.unpriced ? `, ${t.unpriced} unpriced` : ""),
);

// What the Add box searches. Its own try: the page is useful without Add, and a
// Notion hiccup reading Ingredients must not cost the shopping list.
try {
	const { readIngredientRows, pricePerKgLabelFor } = await import("../core/list-intake.js");
	const { buildIngredientIndex } = await import("../core/ingredient-index.js");
	const index = buildIngredientIndex(await readIngredientRows(client), pricePerKgLabelFor);
	await writeFile("public/ingredients.json", JSON.stringify(index), "utf8");
	console.error(`Wrote public/ingredients.json (${index.items.length} searchable ingredients)`);
} catch (e: any) {
	console.error(`Warning: ingredients.json skipped — ${e.message}. Add will still take free text.`);
}
