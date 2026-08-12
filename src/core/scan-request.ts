import { readFile } from "node:fs/promises";

/**
 * "Please scan Sheng Siong now" — the one file the Rescan button and the laptop
 * both understand.
 *
 * The two halves of this system heal on different clocks. The laptop can reach
 * Sheng Siong and the cloud cannot, so a page built without Sheng Siong can only
 * be repaired by a machine the cloud has no way to call. Task Scheduler covers
 * the morning (05:30, then every 30 min to 11:00). This file covers the rest of
 * the day: the button writes it, the laptop reads it and scans.
 *
 * ⚠️ **It is a request, not a command.** Nothing guarantees a laptop is awake to
 * read it, so every consumer treats "no scan happened" as an ordinary outcome
 * and the page keeps whatever it had. A request that goes unanswered costs the
 * user one stale page — the same page they were already looking at when they
 * tapped.
 */

/** Committed to the repo, so the laptop sees it by pulling — no inbound port. */
export const SCAN_REQUEST_FILE = "data/scan-request.json";

export interface ScanRequest {
	v: 1;
	/** SGT date the request was made — the whole expiry mechanism. */
	date: string;
	requestedAt: string;
	reason?: string;
}

export function buildScanRequest(today: string, reason?: string): ScanRequest {
	return { v: 1, date: today, requestedAt: new Date().toISOString(), reason };
}

/**
 * Is this request still worth acting on?
 *
 * ⚠️ Same-day only, and that is the entire safety mechanism. Without it, a
 * laptop opened at 23:00 — or on Thursday, having been shut since Monday —
 * would wake up and scan a shopping day that is already over, then push it as
 * though it were current. A request nobody served simply expires at midnight.
 */
export function isLiveRequest(req: ScanRequest | null, today: string): boolean {
	return !!req && req.v === 1 && req.date === today;
}

/**
 * Has a scan already answered this request?
 *
 * Compares the scan's own `generatedAt` against the request: a scan that
 * finished AFTER the tap is the answer to it. ⚠️ Using "is today's file fresh?"
 * instead would be wrong in the case the button exists for — the file can be
 * fresh, and the user can still be asking for newer prices because a shop
 * changed them since this morning.
 */
export function isRequestServed(req: ScanRequest, scanGeneratedAt: string | null | undefined): boolean {
	if (!scanGeneratedAt) return false;
	const scanned = Date.parse(scanGeneratedAt);
	const asked = Date.parse(req.requestedAt);
	// An unparseable date on either side means we cannot prove it was served.
	// Scanning once too often is a wasted five minutes; skipping the scan the
	// user asked for is the failure they would actually notice.
	if (!Number.isFinite(scanned) || !Number.isFinite(asked)) return false;
	return scanned >= asked;
}

/** The request on disk, or null — a missing file is the normal, quiet state. */
export async function readScanRequest(path: string = SCAN_REQUEST_FILE): Promise<ScanRequest | null> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8"));
		return raw && raw.v === 1 && typeof raw.date === "string" && typeof raw.requestedAt === "string"
			? (raw as ScanRequest)
			: null;
	} catch {
		return null;
	}
}
