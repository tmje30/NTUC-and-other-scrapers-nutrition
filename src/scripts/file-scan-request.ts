import { mkdir, writeFile } from "node:fs/promises";
import { buildScanRequest, SCAN_REQUEST_FILE } from "../core/scan-request.js";
import { sgtDate } from "../core/sgt.js";

/**
 * Write the "please scan Sheng Siong" marker. Run by `scan-request.yml` when the
 * page's Rescan button is tapped; the workflow commits what this writes, and the
 * laptop picks it up on its next pull.
 *
 * ⚠️ The date is SGT, not the runner's UTC. A tap at 07:30 SGT is 23:30 UTC the
 * day BEFORE, and a marker stamped with the UTC date would be read as expired by
 * a laptop that is correctly working in SGT — the request would be discarded the
 * moment it was made, every evening, and only in the evenings.
 */
const reason = process.argv.slice(2).join(" ") || "requested from the deals page";
await mkdir("data", { recursive: true });
const request = buildScanRequest(sgtDate(), reason);
await writeFile(SCAN_REQUEST_FILE, JSON.stringify(request), "utf8");
console.error(`Wrote ${SCAN_REQUEST_FILE}: ${JSON.stringify(request)}`);
