import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_REVIEW, type VendorReviewFile } from "./vendor-review.js";

/**
 * Where price-book review state lives: `data/vendor-review.json`, committed to the repo.
 *
 * Same reasoning as `exclusions-file.ts` and `cooldown-file.ts` — the repo is the one
 * store both halves of the system can see, and no Notion schema change is needed.
 *
 * ⚠️ **The `pending` half is committed too, deliberately.** It is machine-local in
 * spirit (the laptop asks, the laptop answers) and `.sessions/` would be the obvious
 * home. But a pending question that is lost on a reinstall is a question the user
 * answered into the void: they tap OK, the poller has no record of it, and the price
 * never lands. `rejected` has to be committed regardless — it is a standing decision
 * the next scan must honour — so both live here rather than splitting one feature's
 * state across two stores with different durability.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VENDOR_REVIEW_PATH = join(REPO_ROOT, "data", "vendor-review.json");

/** Reads the review file; a missing or corrupt file is treated as "nothing pending". */
export async function readVendorReview(path = VENDOR_REVIEW_PATH): Promise<VendorReviewFile> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8"));
		if (!parsed || typeof parsed !== "object") return EMPTY_REVIEW;
		return {
			version: 1,
			updatedAt: parsed.updatedAt ?? "",
			pending: Array.isArray(parsed.pending) ? parsed.pending : [],
			rejected: Array.isArray(parsed.rejected) ? parsed.rejected : [],
		};
	} catch {
		return EMPTY_REVIEW; // never let a bad file stop a scan
	}
}

export async function writeVendorReview(
	file: VendorReviewFile,
	path = VENDOR_REVIEW_PATH,
): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}
