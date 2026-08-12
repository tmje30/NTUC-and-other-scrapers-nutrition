import { execFileSync } from "node:child_process";
import { config } from "./config.js";

/**
 * "Rebuild the site now" — `repository_dispatch` at this repo's workflows.
 *
 * `repository_dispatch` runs immediately. It is only the `schedule:` trigger
 * that GitHub queues by hours on a free public repo (measured every day 01–04
 * Aug; see HANDOVER "Infrastructure truths"), which is why every runner that
 * wants a prompt rebuild asks for one this way rather than waiting.
 *
 * Two ways in, tried in order:
 *
 *   1. `GITHUB_TOKEN` — a PAT with `contents: read/write`, the permission the
 *      dispatch endpoint requires. Works anywhere, including a phone or a
 *      headless box, and is the only option that survives a locked session.
 *   2. The `gh` CLI, already logged in on this laptop with `repo` scope.
 *
 * ⚠️ **The fallback is what makes this work today, because no `GITHUB_TOKEN` is
 * set on this machine** — not in either clone's `.env`, not in the user or
 * machine environment. Anything that assumed a token was configured has been
 * quietly taking the "no token" branch and waiting for the next daily run.
 *
 * ⚠️ `gh` keeps its token in the OS keyring, which a Task Scheduler job can read
 * while the user is logged in and may not when they are logged out. A scheduled
 * job that must work regardless wants the PAT, not the CLI.
 *
 * Never throws. The data file is pushed before this is ever called, so a failed
 * rebuild request costs latency — the next daily run picks it up — while a throw
 * would take the runner down over it.
 */
export async function dispatchRepositoryEvent(eventType: string): Promise<boolean> {
	const token = process.env.GITHUB_TOKEN;
	if (token) {
		try {
			const res = await fetch(`https://api.github.com/repos/${config.repo()}/dispatches`, {
				method: "POST",
				headers: {
					// ⚠️ `fetch`, not `curl` through a shell: a token passed as a
					// command-line argument is visible to anything that can list
					// processes, and it is the one secret these runners carry.
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ event_type: eventType }),
			});
			if (res.ok) {
				console.error(`Dispatched "${eventType}" — the cloud is rebuilding the page.`);
				return true;
			}
			console.error(`Dispatch "${eventType}" failed — ${res.status} ${res.statusText}.`);
		} catch (e: any) {
			console.error(`Dispatch "${eventType}" failed — ${e.message}.`);
		}
		return false;
	}

	try {
		// `-f` sends a form field, so the event type is never shell-interpreted.
		execFileSync("gh", ["api", `repos/${config.repo()}/dispatches`, "-f", `event_type=${eventType}`], {
			stdio: ["ignore", "ignore", "pipe"],
		});
		console.error(`Dispatched "${eventType}" via the gh CLI — the cloud is rebuilding the page.`);
		return true;
	} catch (e: any) {
		console.error(
			`No GITHUB_TOKEN and the gh CLI could not dispatch "${eventType}" (${e.message?.split("\n")[0]}). ` +
				`The file is pushed; the page will build on the next daily run.`,
		);
		return false;
	}
}
