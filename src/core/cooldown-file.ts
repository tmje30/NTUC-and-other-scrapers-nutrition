import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_COOLDOWNS, type CooldownFile } from "./cooldown.js";

/**
 * Where cooldowns live: `data/cooldowns.json`, committed to the repo.
 *
 * The repo is the only store that both halves of the system can see — the
 * add-to-list workflow writes it, and the daily scan (cloud) reads it — without
 * adding a database or touching the user's Notion schema. Same trick as
 * `data/shengsiong-latest.json`.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const COOLDOWNS_PATH = join(REPO_ROOT, "data", "cooldowns.json");

/** Reads the cooldown file; a missing or corrupt file is treated as "none". */
export async function readCooldowns(path = COOLDOWNS_PATH): Promise<CooldownFile> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (!parsed || !Array.isArray(parsed.entries)) return EMPTY_COOLDOWNS;
		return { version: 1, updatedAt: parsed.updatedAt ?? "", entries: parsed.entries };
	} catch {
		return EMPTY_COOLDOWNS; // never let a bad file stop the daily scan
	}
}

export async function writeCooldowns(file: CooldownFile, path = COOLDOWNS_PATH): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}
