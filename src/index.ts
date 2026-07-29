import { Worker, WebhookVerificationError } from "@notionhq/workers";

const worker = new Worker();
export default worker;

/**
 * One-tap **Add** — the optional upgrade over the deals page's default button.
 *
 * NOT DEPLOYED YET. See `docs/one-tap-add.md` for the setup and the trade-offs.
 *
 * The page is static (GitHub Pages), so it can hold no credentials. By default
 * its Add button opens a pre-filled GitHub issue and you tap Submit; the
 * `add-to-list` workflow then writes the Notion row and the cooldown. This
 * webhook removes that second tap by giving the page something it can POST to.
 *
 * It is deliberately a **thin relay**, not a second implementation: it
 * authenticates the tap and fires a `repository_dispatch` at the SAME workflow.
 *
 *   page ──POST──► this webhook ──repository_dispatch──► add-to-list workflow
 *                                                         ├─ Notion row
 *                                                         └─ cooldowns.json
 *
 * Why not write to Notion from here directly? Because the cooldown has to be
 * committed to the repo, and a worker can't push to git. Splitting the two
 * halves across two runtimes would mean an add could half-succeed — the row
 * created, the cooldown lost — and the item would keep showing up as a deal.
 * One workflow does both or neither.
 */

interface AddRelayEnv {
	/** Fine-grained PAT for the repo: Contents read/write + Metadata read. */
	githubToken: string;
	/** "owner/repo". */
	repo: string;
	/** Shared secret the page holds; travels in the body, not a header (see below). */
	addToken: string;
}

function relayEnv(): AddRelayEnv {
	const githubToken = process.env.GITHUB_TOKEN ?? "";
	const addToken = process.env.ADD_TOKEN ?? "";
	if (!githubToken || !addToken) {
		// Missing config is a verification failure, not a bad request: better to
		// short-circuit than to sit there accepting taps it can never deliver.
		throw new WebhookVerificationError("GITHUB_TOKEN and ADD_TOKEN must be set");
	}
	return {
		githubToken,
		addToken,
		repo: process.env.GITHUB_REPO ?? "tmje30/NTUC-and-other-scrapers-nutrition",
	};
}

/** Constant-time-ish compare, so a wrong token leaks nothing through timing. */
function tokenMatches(given: string, expected: string): boolean {
	if (given.length !== expected.length) return false;
	let diff = 0;
	for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
	return diff === 0;
}

/**
 * Shape check only — `parseAddPayload` in the workflow is the real validator.
 * This exists so obvious junk never costs a workflow run.
 */
function looksLikePayload(p: any): boolean {
	return (
		p &&
		typeof p === "object" &&
		typeof p.ingredientId === "string" &&
		typeof p.ingredient === "string" &&
		typeof p.key === "string" &&
		typeof p.store === "string" &&
		Number(p.priceSgd) > 0
	);
}

worker.webhook("addToGroceryList", {
	title: "Add to grocery list",
	description:
		"Receives an Add tap from the grocery deals page and dispatches the add-to-list workflow, which writes the Notion row and records the item's cooldown.",
	execute: async (events) => {
		const env = relayEnv();

		for (const event of events) {
			// The browser sends this as a CORS "simple request" (text/plain, no custom
			// headers) so it isn't preflighted — a Notion webhook returns no CORS
			// headers, and a preflight would be rejected. That's also why the token
			// travels in the body: an Authorization header would trigger a preflight.
			let parsed: any;
			try {
				parsed = event.rawBody ? JSON.parse(event.rawBody) : event.body;
			} catch {
				throw new WebhookVerificationError("body is not JSON");
			}

			const { token, ...payload } = parsed ?? {};
			if (typeof token !== "string" || !tokenMatches(token, env.addToken)) {
				// 5 consecutive failures short-circuit the webhook until it's
				// redeployed. That's the intended protection — the URL's unique id
				// already keeps it off the open web.
				throw new WebhookVerificationError("bad add token");
			}
			if (!looksLikePayload(payload)) {
				console.error(`Ignoring malformed payload (delivery ${event.deliveryId})`);
				continue;
			}

			const res = await fetch(`https://api.github.com/repos/${env.repo}/dispatches`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${env.githubToken}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "grocery-deals-add",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ event_type: "add-to-list", client_payload: payload }),
			});

			if (!res.ok) {
				throw new Error(`repository_dispatch failed: ${res.status} ${await res.text()}`);
			}
			console.log(`Dispatched add for "${payload.ingredient}" (${payload.store})`);
		}
	},
});
