/**
 * A test harness in forty lines, and deliberately not a test framework.
 *
 * **Why no runner.** This project has no dependencies it does not need, and the
 * things worth testing here are pure functions over strings and numbers —
 * `parseNutritionPanel`, `parseMacroReply`, `isCommodityFood`, `selectPackShots`,
 * and the page's own markup. None of that wants fixtures, mocks, watch mode or a
 * config file. `tsx` already runs TypeScript, so a suite is a script, `npm test`
 * runs them all, and a non-zero exit is a failure. If this ever grows to need
 * setup/teardown or parallelism, that is the moment to reach for vitest — not
 * before.
 *
 * **Why these suites exist at all.** Every one of them was written in a scratchpad
 * during the session that built the feature, proved a real bug, and was then
 * thrown away with the session — four times over. The functions they cover are
 * the ones where being *quietly* wrong is the whole danger: a misread serving
 * size is wrong by 3× and looks plausible, a pack-shot gate that stops firing
 * silently costs 10× per lookup, and a commodity gate that drifts spends real
 * money. None of those announce themselves.
 */

interface Case {
	suite: string;
	label: string;
	ok: boolean;
	detail?: string;
}

const cases: Case[] = [];
let suite = "(unnamed)";

/** Name the suite whose cases follow. Called once at the top of each file. */
export function describe(name: string): void {
	suite = name;
}

/** Assert a boolean. `detail` is printed only on failure. */
export function check(label: string, ok: boolean, detail?: string): void {
	cases.push({ suite, label, ok, detail });
}

/** Assert deep equality by JSON shape — enough for the plain data these functions return. */
export function eq(label: string, got: unknown, want: unknown): void {
	const g = JSON.stringify(got);
	const w = JSON.stringify(want);
	check(label, g === w, g === w ? undefined : `want ${w}\n         got  ${g}`);
}

/**
 * Print every case and exit non-zero if any failed.
 *
 * Passes are printed too, not just failures: the count is the point. A suite that
 * silently stops running its cases still "passes", and that is exactly the
 * failure mode these tests exist to catch elsewhere.
 */
export function report(): never {
	let failed = 0;
	let current = "";
	for (const c of cases) {
		if (c.suite !== current) {
			current = c.suite;
			console.log(`\n${current}`);
		}
		if (!c.ok) failed++;
		console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.label}${c.ok ? "" : `\n         ${c.detail ?? ""}`}`);
	}
	console.log(
		failed
			? `\n${failed} of ${cases.length} FAILED`
			: `\nall ${cases.length} passed`,
	);
	process.exit(failed ? 1 : 0);
}
