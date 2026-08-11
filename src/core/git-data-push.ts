import { execSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Commit one generated data file and push it, surviving a rejected push.
 *
 * The residential runners (`push-shengsiong.ts`, `tg-poll.ts`) each own a data
 * file the cloud reads. Both used to do a bare `git push`, which is fine right
 * up until the clone is behind — and then a scan that worked perfectly is lost:
 *
 * ```
 * 2026-08-05 07:23  laptop woke before DNS was up
 *   git pull   → fatal: Could not resolve host: github.com   (exit code ignored)
 *   npm run push-ss → 58 terms, 0 errors, committed
 *   git push   → rejected, clone 12 commits behind
 *   ⇒ today's Sheng Siong data stranded locally; the cloud built FairPrice-only
 * ```
 *
 * ⚠️ **The recovery is a whole-file re-apply, NOT the three-way merge in
 * `merge-data.ts`.** The two files here are *regenerated in full* by the run
 * that writes them — today's scan is the whole truth about today, so taking the
 * new remote and writing our file over it loses nothing. `cooldowns.json` and
 * `purchases.json` are the opposite: they accumulate entries from runs that
 * never see each other, which is why those need a merge and these must not have
 * one. Don't unify the two paths.
 *
 * ⚠️ **`git pull --rebase` is not the recovery** — it replays our commit, and a
 * remote that also rewrote this file is a content conflict it cannot resolve.
 * The rebase then dies and takes the run with it, *after* the scan succeeded.
 * Same lesson as `add-to-list.yml`'s commit step; see HANDOVER.
 */

export interface DataPushOptions {
	/** Repo-relative path of the file this run owns outright. */
	file: string;
	/** Commit message. */
	message: string;
	/** Push attempts before giving up. */
	attempts?: number;
	/** The clone to work in. Defaults to the process's own directory. */
	cwd?: string;
	/**
	 * How to re-apply this run's change onto a NEWER remote, when the file is not
	 * this run's to overwrite. `theirs` is the file as it now stands upstream (null
	 * if upstream hasn't got one); `mine` is what this run wrote. Return the text to
	 * commit. Default: `mine`, verbatim.
	 *
	 * ⚠️ **This does not soften the rule in the header above; it is the exception the
	 * rule needs.** `shengsiong-latest.json` and `new-items-latest.json` are
	 * regenerated in full by the run that writes them, so overwriting is correct and
	 * a merge would be wrong. `tg-inbox-state.json` is the opposite: the cloud edits
	 * it on every tap, so a runner that drained the queue and then wrote its whole
	 * copy over the remote would resurrect questions the user had answered in the
	 * meantime — with live buttons, as if they had never been touched. Such a caller
	 * passes a `reapply` that keeps theirs and re-applies only its own change.
	 */
	reapply?: (theirs: string | null, mine: string) => string | Promise<string>;
}

export type DataPushResult = "pushed" | "nothing-to-commit" | "already-upstream";

function git(args: string, cwd: string): string {
	return execSync(`git ${args}`, { encoding: "utf8", cwd });
}

function gitOk(args: string, cwd: string): boolean {
	try {
		execSync(`git ${args}`, { stdio: "inherit", cwd });
		return true;
	} catch {
		return false;
	}
}

/** True when `git add` staged nothing — i.e. the file is byte-identical to HEAD. */
function nothingStaged(cwd: string): boolean {
	return gitQuiet("diff --cached --quiet", cwd);
}

/** Run a git command for its exit code alone, showing nothing. */
function gitQuiet(args: string, cwd: string): boolean {
	try {
		execSync(`git ${args}`, { cwd, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/** `origin/main` — the tracking branch, however this clone happens to name it. */
function upstream(cwd: string): string {
	try {
		return git("rev-parse --abbrev-ref --symbolic-full-name @{u}", cwd).trim();
	} catch {
		return `origin/${git("rev-parse --abbrev-ref HEAD", cwd).trim()}`;
	}
}

/**
 * Anything uncommitted that ISN'T the file we own.
 *
 * The recovery below resets the working tree to the remote, which would throw
 * away whatever else is sitting there. In the dedicated runner clone that set is
 * always empty — but `tg-poll.ts` is meant to run on the dev machine (it needs
 * NOTION_TOKEN), and quietly discarding a session's work to save a scan is not a
 * trade this script gets to make.
 */
function otherLocalChanges(file: string, cwd: string): string[] {
	const want = file.replace(/\\/g, "/");
	return git("status --porcelain", cwd)
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.filter((l) => l.slice(2).trim().replace(/^"|"$/g, "") !== want);
}

export async function commitAndPushData(opts: DataPushOptions): Promise<DataPushResult> {
	const { file, message } = opts;
	const attempts = opts.attempts ?? 5;
	const cwd = opts.cwd ?? process.cwd();
	const path = join(cwd, file);

	execSync(`git add ${file}`, { stdio: "inherit", cwd });
	if (nothingStaged(cwd)) {
		console.error("No changes to commit.");
		return "nothing-to-commit";
	}

	// What this run meant to end up with, captured ONCE before the first push —
	// so every attempt re-applies this same content onto the newest remote
	// rather than picking up whatever a later run left in the file.
	const mine = await readFile(path, "utf8");
	const dirty = otherLocalChanges(file, cwd);

	execSync(`git commit -m "${message}"`, { stdio: "inherit", cwd });

	for (let attempt = 1; attempt <= attempts; attempt++) {
		if (gitOk("push", cwd)) {
			console.error("Pushed.");
			return "pushed";
		}

		if (dirty.length) {
			throw new Error(
				`Push rejected, and this clone has ${dirty.length} other uncommitted ` +
					`change(s) — refusing to reset the working tree over them.\n` +
					`  ${dirty.join("\n  ")}\n` +
					`${file} is committed locally: land it with \`git pull --rebase\` by hand.`,
			);
		}

		const up = upstream(cwd);
		console.error(`Push rejected — re-applying ${file} onto ${up} (attempt ${attempt}/${attempts}).`);

		// A fetch that fails is not a race with another runner, it's no network
		// (or no credential) — retrying that four more times only delays the
		// error the user needs to see.
		const fetchArgs = `fetch ${up.replace("/", " ")}`; // "origin/main" → "origin main"
		if (!gitOk(fetchArgs, cwd)) {
			throw new Error(`git ${fetchArgs} failed — offline or unauthenticated, not a push race.`);
		}

		execSync(`git reset --hard ${up}`, { stdio: "inherit", cwd });
		// The reset has just put THEIRS in the working tree. Read it before writing,
		// so a caller that has to preserve the other side's edits can see them.
		let theirs: string | null = null;
		try {
			theirs = await readFile(path, "utf8");
		} catch {
			theirs = null; // upstream doesn't have this file yet
		}
		await writeFile(path, opts.reapply ? await opts.reapply(theirs, mine) : mine, "utf8");
		execSync(`git add ${file}`, { stdio: "inherit", cwd });
		if (nothingStaged(cwd)) {
			console.error("Already applied upstream — nothing left to push.");
			return "already-upstream";
		}
		execSync(`git commit -m "${message}"`, { stdio: "inherit", cwd });
	}

	throw new Error(`Could not push ${file} after ${attempts} attempts.`);
}
