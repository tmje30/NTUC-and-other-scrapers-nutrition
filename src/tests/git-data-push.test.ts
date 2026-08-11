import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, check, eq } from "./harness.js";
import { commitAndPushData } from "../core/git-data-push.js";

/**
 * The runner's push, against a real (local) remote.
 *
 * ⚠️ **This is the one suite that shells out.** Every other file here tests a
 * pure function, and that is still the rule — but the thing being tested *is*
 * git's behaviour under a rejected push, and a mocked git would only prove the
 * mock agrees with itself. It stays offline and free: the "remote" is a bare
 * repo in the temp directory, nothing touches the network, and the whole suite
 * runs in about a second.
 *
 * What it pins is the 2026-08-05 failure: the laptop scanned 58 terms perfectly,
 * pushed into a clone 12 commits behind, and the day's Sheng Siong data was
 * stranded locally while the cloud built FairPrice-only. Silence was the entire
 * problem — the scan reported success.
 */

describe("runner push — a rejected push must not lose the scan");

const root = mkdtempSync(join(tmpdir(), "gitpush-"));
const FILE = "data/x.json";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

/** A bare remote, the runner's clone, and a second clone standing in for the cloud. */
function sandbox(): { runner: string; other: string } {
	const remote = join(root, `remote-${Math.random().toString(36).slice(2)}.git`);
	git(root, "init", "--quiet", "--bare", "-b", "main", remote);
	const seed = join(root, `seed-${Math.random().toString(36).slice(2)}`);
	git(root, "clone", "--quiet", remote, seed);
	git(seed, "config", "user.email", "t@example.com");
	git(seed, "config", "user.name", "test");
	mkdirSync(join(seed, "data"), { recursive: true });
	writeFileSync(join(seed, FILE), '{"day":0}');
	git(seed, "add", "-A");
	git(seed, "commit", "--quiet", "-m", "seed");
	git(seed, "push", "--quiet", "-u", "origin", "main");

	const clone = (name: string): string => {
		const dir = join(root, `${name}-${Math.random().toString(36).slice(2)}`);
		git(root, "clone", "--quiet", remote, dir);
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "user.name", "test");
		return dir;
	};
	return { runner: clone("runner"), other: clone("other") };
}

/** Someone else pushes first — the state that rejects the runner's push. */
function remoteMovesAhead(other: string, extraFile?: string): void {
	git(other, "pull", "--quiet");
	writeFileSync(join(other, FILE), '{"day":1,"from":"someone-else"}');
	if (extraFile) writeFileSync(join(other, extraFile), "their work\n");
	git(other, "add", "-A");
	git(other, "commit", "--quiet", "-m", "the other runner");
	git(other, "push", "--quiet");
}

const onRemote = (dir: string, file: string): string => {
	git(dir, "fetch", "--quiet", "origin");
	return git(dir, "show", `origin/main:${file}`);
};

// ── the recovery ────────────────────────────────────────────────────────────
{
	const { runner, other } = sandbox();
	remoteMovesAhead(other, "theirs.txt");
	writeFileSync(join(runner, FILE), '{"day":1,"from":"laptop","terms":58}');

	const result = await commitAndPushData({ file: FILE, message: "data: scan", cwd: runner });

	eq("a rejected push is retried, not abandoned", result, "pushed");
	eq(
		"today's scan is what ends up on the remote",
		JSON.parse(onRemote(runner, FILE)).from,
		"laptop",
	);
	check(
		"the other runner's unrelated commit survives",
		onRemote(runner, "theirs.txt").trim() === "their work",
		"the recovery took the new remote wholesale and re-applied only our file",
	);
	check(
		"nothing is left uncommitted afterwards",
		git(runner, "status", "--porcelain").trim() === "",
	);
}

// ── the guard that protects a dev clone ─────────────────────────────────────
{
	const { runner, other } = sandbox();
	remoteMovesAhead(other);
	writeFileSync(join(runner, FILE), '{"day":1,"from":"laptop"}');
	// tg-poll runs where the user works, so the tree may hold real work.
	writeFileSync(join(runner, "half-written.ts"), "// mid-edit\n");

	let threw = "";
	try {
		await commitAndPushData({ file: FILE, message: "data: scan", cwd: runner });
	} catch (e: any) {
		threw = e.message;
	}

	check("a dirty clone refuses the reset", threw.includes("refusing to reset"));
	check(
		"and says how to land the file by hand",
		threw.includes("committed locally"),
		`got: ${threw}`,
	);
	check(
		"the unrelated work is still there",
		existsSync(join(runner, "half-written.ts")) &&
			readFileSync(join(runner, "half-written.ts"), "utf8") === "// mid-edit\n",
	);
	check(
		"the scan is not lost either — it is committed locally",
		git(runner, "log", "--oneline", "-1").includes("data: scan"),
	);
}

// ── offline is not a race ───────────────────────────────────────────────────
{
	const { runner } = sandbox();
	writeFileSync(join(runner, FILE), '{"day":1,"from":"laptop"}');
	git(runner, "remote", "set-url", "origin", join(root, "gone.git"));

	let threw = "";
	try {
		await commitAndPushData({ file: FILE, message: "data: scan", cwd: runner });
	} catch (e: any) {
		threw = e.message;
	}
	check(
		"an unreachable remote fails fast instead of retrying five times",
		threw.includes("offline or unauthenticated"),
		`got: ${threw}`,
	);
}

// ── the no-op cases ─────────────────────────────────────────────────────────
{
	const { runner } = sandbox();
	// push-ss self-gates on a fresh file, but --force re-scans and can produce
	// byte-identical output; that must not manufacture an empty commit.
	const same = await commitAndPushData({ file: FILE, message: "data: scan", cwd: runner });
	eq("an unchanged file is not committed", same, "nothing-to-commit");
}

{
	const { runner, other } = sandbox();
	remoteMovesAhead(other);
	// The rare tie: the remote already carries exactly what we scanned.
	writeFileSync(join(runner, FILE), '{"day":1,"from":"someone-else"}');
	const tie = await commitAndPushData({ file: FILE, message: "data: scan", cwd: runner });
	eq("a remote that already agrees ends the retry", tie, "already-upstream");
	check("with no empty commit left behind", git(runner, "status", "--porcelain").trim() === "");
}

// ── reapply: the file this run does NOT own outright ────────────────────────
//
// ⚠️ The default recovery writes our whole file over the new remote, which is right
// for a scan (today's scan is the whole truth about today) and wrong for the inbox
// state file: the cloud edits that on every tap, so overwriting it would put back
// questions the user has answered since we read it — on screen, with live buttons.
{
	const { runner, other } = sandbox();
	// Their newer copy: one question still open, one item still queued.
	git(other, "pull", "--quiet");
	writeFileSync(join(other, FILE), JSON.stringify({ asks: [{ token: "theirs" }], queue: ["a", "b"] }));
	git(other, "add", "-A");
	git(other, "commit", "--quiet", "-m", "a tap arrived in the cloud");
	git(other, "push", "--quiet");

	// Our copy is stale — it predates their question — and all we are entitled to
	// say is "I priced item a".
	writeFileSync(join(runner, FILE), JSON.stringify({ asks: [], queue: ["b"] }));

	const result = await commitAndPushData({
		file: FILE,
		message: "data: priced a queued item",
		cwd: runner,
		reapply(theirs) {
			const file = JSON.parse(theirs ?? "{}");
			file.queue = (file.queue ?? []).filter((q: string) => q !== "a");
			return JSON.stringify(file);
		},
	});

	eq("the re-applied push lands", result, "pushed");
	const landed = JSON.parse(onRemote(runner, FILE));
	check(
		"the question that arrived meanwhile is NOT resurrected",
		landed.asks.length === 1 && landed.asks[0].token === "theirs",
		`got asks: ${JSON.stringify(landed.asks)}`,
	);
	eq("and only the priced item left the queue", landed.queue, ["b"]);
}

{
	// The default must stay the default: a caller that passes no `reapply` still
	// overwrites, or every existing runner changes behaviour silently.
	const { runner, other } = sandbox();
	remoteMovesAhead(other);
	writeFileSync(join(runner, FILE), '{"day":1,"from":"laptop"}');
	await commitAndPushData({ file: FILE, message: "data: scan", cwd: runner });
	eq(
		"without reapply, the run's own file still wins wholesale",
		JSON.parse(onRemote(runner, FILE)).from,
		"laptop",
	);
}

rmSync(root, { recursive: true, force: true });
