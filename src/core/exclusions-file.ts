import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_EXCLUSIONS, type ExclusionFile } from "./exclusions.js";

/**
 * Where per-item exclusions live: `data/exclusions.json`, committed to the repo.
 *
 * Same reasoning as `cooldown-file.ts` — the repo is the one store both halves
 * of the system can see. The item-actions workflow writes it, the daily scan
 * (cloud) reads it, and no database or Notion schema change is needed.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const EXCLUSIONS_PATH = join(REPO_ROOT, "data", "exclusions.json");

/** Reads the exclusions file; a missing or corrupt file is treated as "none". */
export async function readExclusions(path = EXCLUSIONS_PATH): Promise<ExclusionFile> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return EMPTY_EXCLUSIONS;
		return {
			version: 1,
			updatedAt: parsed.updatedAt ?? "",
			terms: Array.isArray(parsed.terms) ? parsed.terms : [],
			products: Array.isArray(parsed.products) ? parsed.products : [],
		};
	} catch {
		return EMPTY_EXCLUSIONS; // never let a bad file stop the daily scan
	}
}

export async function writeExclusions(file: ExclusionFile, path = EXCLUSIONS_PATH): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}
