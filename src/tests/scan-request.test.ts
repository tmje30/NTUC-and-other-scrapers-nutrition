import { buildScanRequest, isLiveRequest, isRequestServed, type ScanRequest } from "../core/scan-request.js";
import { renderDealsPage } from "../core/site.js";
import { check, describe, eq } from "./harness.js";

/**
 * The Rescan button's contract: a marker the cloud writes and the laptop reads.
 *
 * ⚠️ The two rules under test are the ones that decide whether a five-minute
 * scan runs, on a job that fires every five minutes all day. Getting `isLive`
 * wrong scans a shopping day that is over; getting `isServed` wrong either scans
 * on a loop or ignores the tap the user just made.
 */
describe("scan request — when a request is still worth serving");

const req = (over: Partial<ScanRequest> = {}): ScanRequest => ({
	v: 1,
	date: "2026-08-12",
	requestedAt: "2026-08-12T10:30:00.000Z",
	...over,
});

check("today's request is live", isLiveRequest(req(), "2026-08-12"));
check("yesterday's has expired", !isLiveRequest(req(), "2026-08-13"));
check("no request at all is not live", !isLiveRequest(null, "2026-08-12"));
// A future version of the file is one this build does not understand. Ignoring it
// leaves the page stale; acting on it would act on fields that may have moved.
check("an unknown version is ignored", !isLiveRequest(req({ v: 2 as 1 }), "2026-08-12"));

describe("scan request — has a scan already answered it");

check("a scan finished after the tap serves it", isRequestServed(req(), "2026-08-12T10:31:00.000Z"));
check("the same instant counts as served", isRequestServed(req(), "2026-08-12T10:30:00.000Z"));
// ⚠️ The case the button exists for: today's file can be perfectly fresh and the
// user can still be asking for newer prices. A scan from this morning does NOT
// answer a tap made this afternoon.
check("this morning's scan does not serve this afternoon's tap", !isRequestServed(req(), "2026-08-12T01:58:00.000Z"));
check("a missing scan file serves nothing", !isRequestServed(req(), null));
check("an unreadable date serves nothing", !isRequestServed(req(), "not a date"));

describe("scan request — the marker it writes");

const built = buildScanRequest("2026-08-12", "requested from the deals page");
eq("carries the SGT date it was given", built.date, "2026-08-12");
eq("is version 1", built.v, 1);
check("stamps a parseable instant", Number.isFinite(Date.parse(built.requestedAt)));
check("its own marker is live on its own day", isLiveRequest(built, "2026-08-12"));

describe("scan request — the button on the page");

const page = (warning?: string) =>
	renderDealsPage([], [], new Date("2026-08-12T02:00:00Z"), [], {
		repo: "tmje30/NTUC-and-other-scrapers-nutrition",
		warning,
	});

const warned = page("Sheng Siong is missing from this scan — yesterday's data is the latest.");

// ⚠️ `sscan`, not `rescan`. Firing `rescan` is what made this button useless: it
// rebuilt the page from the same file and returned the same warning. If this
// assertion ever flips back, the button has quietly gone back to redrawing.
check("Rescan asks for a real scan, not a redraw", /data-event="sscan"/.test(warned));
check("it does not fire a bare rebuild", !/data-event="rescan"/.test(warned));
check("its tick says requested, not done", /data-done="✓ requested/.test(warned));
check("it points at the scan-request workflow as a fallback", /workflows\/scan-request\.yml/.test(warned));
// The latency is the honest part of the promise — the button is worthless if the
// user taps it and waits three minutes for a page that never changes.
//
// ⚠️ The number changed from 10 minutes to 4 on 2026-08-13, when `scan-request.yml`
// stopped committing a marker for the laptop's five-minute poller and started
// calling the Cloudflare Worker directly. Measured end to end: ~60s to scan,
// ~2m40s to rebuild and deploy. Keep this assertion specific rather than loosening
// it to /minutes/ — a promise that drifts away from the truth is the exact failure
// it was written to catch, and only a literal will notice.
check("the hint names the wait", /4 minutes/.test(warned));
// ⚠️ Matched on the instruction, not the word "laptop" — the hint deliberately says
// "no laptop needed", so a bare /laptop/ test fails on the very sentence that fixes
// the problem. What must not come back is the old *dependency*: "leave it open".
check("…and no longer tells the user to leave the laptop open", !/leave it open/i.test(warned));
check("…saying instead that no laptop is needed", /no laptop\s+needed/i.test(warned));

// No missing shop, no button: there is nothing for the laptop to fetch.
check("no warning means no button", !/data-event="sscan"/.test(page(undefined)));
