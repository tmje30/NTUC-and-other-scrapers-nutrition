import { sgtDate, sgtLongDate } from "../core/sgt.js";
import { describe, eq } from "./harness.js";

/**
 * Singapore time.
 *
 * ⚠️ **The whole suite is about the 00:00–08:00 SGT window, because that is when
 * this system runs.** The daily scan is requested at 00:00 UTC and dequeued three
 * to four hours later, so every scan of the last year has landed inside the one
 * window where a UTC date and a Singapore date disagree. A date computed without
 * the offset is not "occasionally a day out" here — it is a day out on the exact
 * runs that matter, and the effect is silent: `shengsiong-file.ts` compares the
 * scan file's date to today and quietly contributes NOTHING when they differ, so
 * the page goes FairPrice-only and nothing says why.
 *
 * These cases are why `sgtDate` takes an injectable `now`. The offset used to be
 * copy-pasted into four modules and inlined in a fifth, where it could only be
 * asserted in a comment.
 */
describe("singapore time — the date the shops are in");

// The boundary itself: 16:00 UTC IS midnight SGT, so this instant is already
// tomorrow in Singapore while UTC still calls it today.
eq("midnight SGT is the new day", sgtDate(new Date("2026-08-11T16:00:00Z")), "2026-08-12");
eq("one second earlier is not", sgtDate(new Date("2026-08-11T15:59:59Z")), "2026-08-11");

// 23:00 UTC = 07:00 SGT — inside the window the daily scan actually runs in.
eq("the scan window reads as today", sgtDate(new Date("2026-08-11T23:00:00Z")), "2026-08-12");

// Well clear of the boundary, where naive and correct agree. Kept so a rewrite
// that "fixed" the offset by removing it fails here too, not only at the edges.
eq("mid-morning SGT is unambiguous", sgtDate(new Date("2026-08-12T00:30:00Z")), "2026-08-12");

// The offset has to carry the month and the year, not just the day number.
eq("across a year boundary", sgtDate(new Date("2026-12-31T16:00:00Z")), "2027-01-01");
eq("across a month boundary", sgtDate(new Date("2026-02-28T16:00:00Z")), "2026-03-01");

/**
 * ⚠️ **The regression guard proper.** Every case above is one where dropping the
 * `+8h` still yields a valid-looking `YYYY-MM-DD` — just the wrong one. Asserting
 * that the two disagree is what stops the offset being "simplified" away by
 * someone who sees `toISOString().slice(0, 10)` and recognises the anti-pattern
 * without noticing the line before it.
 */
const naive = (iso: string) => new Date(iso).toISOString().slice(0, 10);
eq("naive UTC would name the previous day at midnight SGT", naive("2026-08-11T16:00:00Z"), "2026-08-11");
eq("and during the scan window", naive("2026-08-11T23:00:00Z"), "2026-08-11");
eq("and would lose the new year", naive("2026-12-31T16:00:00Z"), "2026-12-31");

describe("singapore time — the date a person reads");

/**
 * ⚠️ `sgtLongDate` names the weekday, and the weekday is the point: the sentence
 * it appears in is "not searched until Mon, 17 Aug 2026". Computed in UTC, a
 * cooldown expiring at a Singapore midnight would name the day BEFORE — telling
 * the user "until Sunday" for a snooze that ends on Monday.
 */
eq("a Singapore midnight names the right weekday", sgtLongDate(new Date("2026-08-11T16:00:00Z")), "Wed, 12 Aug 2026");
eq("and the moment before it names the previous one", sgtLongDate(new Date("2026-08-11T15:59:59Z")), "Tue, 11 Aug 2026");
eq("across a year boundary", sgtLongDate(new Date("2026-12-31T16:00:00Z")), "Fri, 1 Jan 2027");

// The two functions must agree on which day it is, however differently they get
// there — one by offset arithmetic, one through Intl.
const both = new Date("2026-08-11T16:00:00Z");
eq("the two routes agree on the day", [sgtDate(both), sgtLongDate(both)], ["2026-08-12", "Wed, 12 Aug 2026"]);
