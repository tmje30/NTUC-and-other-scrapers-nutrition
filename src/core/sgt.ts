/**
 * Singapore time, in the two shapes this system actually needs.
 *
 * Every shop, every price and every cooldown in this project is Singaporean, and
 * the runners are not: the cloud scan runs on GitHub's UTC machines, the laptop
 * runner on whatever the user's clock says. A date computed in the host's zone is
 * wrong somewhere, so nothing here reads the local zone.
 *
 * ⚠️ **Both functions existed, separately, five times over.** `sgtDate` was
 * copy-pasted verbatim into four modules plus one inlined copy in `build-site.ts`,
 * and `item-action.ts` grew its own `Intl` version under the same name for a
 * different job. Two implementations of "what day is it in Singapore", sharing a
 * name and disagreeing about method, is how the wrong one eventually gets copied.
 * They live here together now, and the difference between them is the point:
 *
 *   `sgtDate`     — YYYY-MM-DD, a DATA value. It is written into
 *                   `shengsiong-latest.json` and `new-items-latest.json`, and
 *                   compared for equality to decide whether a scan is today's.
 *   `sgtLongDate` — "Mon, 12 Aug 2026", a DISPLAY value, for a sentence a person
 *                   reads on the issue thread.
 *
 * Never swap one for the other. A display string will never compare equal to a
 * stored date, and a bare `YYYY-MM-DD` in a sentence about "until Monday" is the
 * fault documented on `sgtLongDate` below.
 */

/**
 * Today's date in Singapore as `YYYY-MM-DD`.
 *
 * ⚠️ **The `+8h` is not a shortcut for a real timezone library, it is the whole
 * calculation.** Singapore is UTC+8 with **no DST** and has been since 1982, so
 * shifting the instant forward by eight hours and taking the UTC calendar date is
 * exactly right — there is no transition to be caught out by. This is the one
 * place where `toISOString().slice(0, 10)` is correct, and it is correct only
 * because of the offset applied first. Dropping that offset silently produces the
 * previous day for the whole 00:00–08:00 SGT window, which is precisely when the
 * daily scan runs.
 *
 * `now` is injectable so the behaviour above can be tested at the boundary rather
 * than asserted in a comment.
 */
export function sgtDate(now: Date = new Date()): string {
	return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

/**
 * A date as the user reads it — "Mon, 12 Aug 2026".
 *
 * ⚠️ **Never `toISOString().slice(0, 10)` for a cooldown that lands on a Singapore
 * midnight**: that instant is 16:00 the PREVIOUS day in UTC, so the report would
 * name the wrong day — and, for "ignore until Monday", name a Sunday. Unlike
 * `sgtDate` above there is no offset to apply here, because `Intl` is doing the
 * conversion properly; the two arrive at the same answer by different routes.
 */
export function sgtLongDate(d: Date): string {
	return d.toLocaleDateString("en-SG", {
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
		timeZone: "Asia/Singapore",
	});
}
