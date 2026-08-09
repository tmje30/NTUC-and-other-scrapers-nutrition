import { Client } from "@notionhq/client";
import { config } from "../core/config.js";

/**
 * Dev script: dump the Ingredients data source focused on the fields that drive
 * matching + the baseline, so we can design the parsers against real values.
 *
 * Run: npm run sample
 */

const INGREDIENTS_DS = "34b69a18-4fe7-80e6-904e-000b208cf560";
const client = new Client({ auth: config.notionToken() });

function num(p: any): string {
	if (p?.type === "number") return String(p.number);
	if (p?.type === "formula" && p.formula?.type === "number") return String(p.formula.number);
	return "?";
}
function str(p: any): string {
	if (p?.type === "title") return (p.title ?? []).map((r: any) => r.plain_text).join("");
	if (p?.type === "select") return p.select?.name ?? "";
	if (p?.type === "formula" && p.formula?.type === "string") return p.formula.string ?? "";
	return "";
}

async function main() {
	let cursor: string | undefined;
	let n = 0;
	do {
		const res = (await client.dataSources.query({
			data_source_id: INGREDIENTS_DS,
			page_size: 100,
			start_cursor: cursor,
		} as any)) as any;
		for (const row of res.results as any[]) {
			const p = row.properties;
			const name = str(p["Name"]);
			if (!name) continue;
			const unit = str(p["Unit type "]);
			const u1 = str(p["Used '1' Plan"]);
			const u2 = str(p["Used '2' Plan"]);
			const u3 = str(p["Used '3' Plan"]);
			const inPlans = [u1 && "1", u2 && "2", u3 && "3"].filter(Boolean).join("");
			n++;
			console.log(
				`\n#${n} ${JSON.stringify(name)}  [${unit}]  plans:${inPlans || "-"}  ` +
					// The price book, not the retired baseline columns — `Price,SGD` is gone
				// and `Price per 100g ` still points at it, so both read as nothing now.
				`price=${num(p["Price,SGD [Cheapest]"])} ` +
					`v1=${num(p["Price [Vendor 1]"])}/${num(p["Size[Vendor 1]"])}`,
			);
			if (u1) console.log(`   U1: ${JSON.stringify(u1)}`);
			if (u2) console.log(`   U2: ${JSON.stringify(u2)}`);
			if (u3) console.log(`   U3: ${JSON.stringify(u3)}`);
		}
		cursor = res.has_more ? res.next_cursor : undefined;
	} while (cursor);
	console.log(`\nTotal named ingredients: ${n}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
