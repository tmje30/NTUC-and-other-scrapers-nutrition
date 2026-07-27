import { Client } from "@notionhq/client";
import { config } from "../core/config.js";

/**
 * Dev/setup script. Reads live Notion structure so we can tune the parsers
 * against reality instead of guessing (per the PRD's open questions).
 *
 * Run:  npm run introspect
 * Needs: NOTION_TOKEN in .env, with both DBs shared to the integration.
 *
 * Notion API 2025-09-03 / SDK v5: databases contain one or more DATA SOURCES;
 * schema + rows live on the data source, not the database.
 */

const client = new Client({ auth: config.notionToken() });

function plain(rich: any[] | undefined): string {
	return (rich ?? []).map((r) => r.plain_text).join("");
}

function summariseValue(prop: any): string {
	switch (prop?.type) {
		case "title":
		case "rich_text":
			return JSON.stringify(plain(prop[prop.type]));
		case "number":
			return String(prop.number);
		case "select":
			return prop.select?.name ?? "null";
		case "multi_select":
			return (prop.multi_select ?? []).map((s: any) => s.name).join("|");
		case "formula": {
			const f = prop.formula;
			return `formula(${f?.type})=${JSON.stringify(f?.[f?.type])}`;
		}
		case "relation":
			return `relation[${(prop.relation ?? []).length}]`;
		case "rollup":
			return `rollup(${prop.rollup?.type})`;
		default:
			return `<${prop?.type}>`;
	}
}

function dataSourceTitle(ds: any): string {
	// A data source from search may carry name/title in a few shapes.
	if (typeof ds.name === "string") return ds.name;
	if (Array.isArray(ds.name)) return plain(ds.name);
	if (Array.isArray(ds.title)) return plain(ds.title);
	return "(untitled)";
}

async function main() {
	console.log("=== Data sources accessible to this integration ===\n");

	// API 2025-09-03: search returns data sources (not databases). `value`
	// must be "page" or "data_source".
	const found = await client.search({
		filter: { value: "data_source", property: "object" },
		page_size: 100,
	} as any);

	if (!found.results.length) {
		console.log(
			"Nothing returned. Make sure you've SHARED each database with the\n" +
				"integration (••• menu → Connections → your integration).",
		);
		return;
	}

	for (const ds of found.results as any[]) {
		console.log(`DATA SOURCE  "${dataSourceTitle(ds)}"  id=${ds.id}`);
		if (ds.database_parent?.database_id) {
			console.log(`  parent database id=${ds.database_parent.database_id}`);
		}

		// Schema
		try {
			const dsFull = (await client.dataSources.retrieve({ data_source_id: ds.id })) as any;
			const props = dsFull.properties ?? {};
			console.log("  Properties:");
			for (const [name, def] of Object.entries<any>(props)) {
				console.log(`    - ${name}: ${def.type}`);
			}
		} catch (e: any) {
			console.log(`  ! schema retrieve failed: ${e.message}`);
		}

		// Sample rows
		try {
			const rows = (await client.dataSources.query({
				data_source_id: ds.id,
				page_size: 3,
			} as any)) as any;
			console.log(`  Sample rows (${rows.results.length}):`);
			for (const row of rows.results as any[]) {
				console.log(`    • page ${row.id}`);
				for (const [name, prop] of Object.entries<any>(row.properties)) {
					console.log(`        ${name} = ${summariseValue(prop)}`);
				}
			}
		} catch (e: any) {
			console.log(`  ! query failed: ${e.message}`);
		}
		console.log("");
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
