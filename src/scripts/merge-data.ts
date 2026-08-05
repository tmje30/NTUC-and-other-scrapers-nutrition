/**
 * Re-apply this run's data change on top of whatever landed upstream meanwhile.
 *
 *     npx tsx src/scripts/merge-data.ts <baseDir> <mineDir> [dataDir]
 *
 * Called by `add-to-list.yml` and `item-actions.yml` when a push is rejected.
 * By then the working tree has been reset to the new `origin/main`, so `dataDir`
 * (default `data/`) holds THEIRS; `baseDir` holds the files as they were before
 * this run touched anything, and `mineDir` what this run produced. The merged
 * result is written back into `dataDir`, ready to commit and push again.
 *
 * See `src/core/merge-data.ts` for the rule and why a plain union is wrong.
 *
 * Files absent from `mineDir` are left alone: a run that only wrote cooldowns has
 * nothing to say about exclusions, and rewriting a file it never touched would be
 * a chance to corrupt one for nothing.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATA_FILES, mergeDataFile } from "../core/merge-data.js";

const [baseDir, mineDir, dataDir = "data"] = process.argv.slice(2);
if (!baseDir || !mineDir) {
	console.error("usage: merge-data.ts <baseDir> <mineDir> [dataDir]");
	process.exit(2);
}

const read = (p: string): Record<string, unknown> | null => {
	if (!existsSync(p)) return null;
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		throw new Error(`${p} is not valid JSON: ${(e as Error).message}`);
	}
};

let merged = 0;
for (const name of Object.keys(DATA_FILES)) {
	const mine = read(join(mineDir, name));
	if (!mine) continue;

	const live = join(dataDir, name);
	const theirs = read(live);
	// Upstream may not have the file at all (the first ever write of it). Mine is
	// then the whole truth and there is nothing to merge against.
	if (!theirs) {
		writeFileSync(live, `${JSON.stringify(mine, null, 2)}\n`);
		console.error(`${name}: no upstream copy — wrote mine as-is`);
		merged++;
		continue;
	}

	const out = mergeDataFile(name, read(join(baseDir, name)), mine, theirs);
	writeFileSync(live, `${JSON.stringify(out, null, 2)}\n`);

	// Counts, not contents: the log is public and these files name what the user
	// buys. Enough to tell a real merge from a no-op when reading a failed run.
	const sizes = DATA_FILES[name]
		.map((s) => `${s.field} ${(out[s.field] as unknown[]).length}`)
		.join(", ");
	console.error(`${name}: merged onto upstream — ${sizes}`);
	merged++;
}

if (merged === 0) console.error("nothing to merge");
