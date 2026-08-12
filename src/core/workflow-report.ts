import { appendFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

/**
 * Hand a one-line result back to the workflow that invoked this script, which
 * posts it as a comment on the issue and then closes it.
 *
 * The privileged half of every button on the pages — Add, Buy, Ignore, Reset,
 * Mismatch — is a script run by Actions, and this is how all of them speak back to
 * the person who tapped. `add-to-list.ts` and `item-action.ts` each carried an
 * identical private copy; the delimiter fault below therefore had to be fixed
 * twice, which is reason enough for there to be one.
 *
 * ⚠️ **The heredoc delimiter is randomised per call, and a literal `EOF` is not
 * good enough.** `summary` quotes the product — `itemName`, `vendor` — and that
 * text is not ours: it arrives in `ISSUE_BODY`, having started life as a title
 * someone typed into a shop listing. A Carousell seller writes their own. A title
 * carrying a line that is exactly `EOF` ends the block early, and everything after
 * it is read by Actions as further `name=value` output rather than as prose — so a
 * crafted listing could set workflow outputs this script never wrote. A random
 * delimiter cannot be guessed by someone writing a title days earlier, which is
 * why GitHub documents this form.
 *
 * ⚠️ **`GITHUB_OUTPUT` unset is a normal state, not a failure.** These scripts are
 * also run by hand from the repo root while diagnosing something, where there is
 * no workflow to answer. The summary still goes to stdout; only the handback is
 * skipped.
 */
export async function report(summary: string): Promise<void> {
	console.log(summary);
	const out = process.env.GITHUB_OUTPUT;
	if (!out) return;
	const delim = `EOF_${randomUUID()}`;
	await appendFile(out, `summary<<${delim}\n${summary}\n${delim}\n`, "utf8");
}
