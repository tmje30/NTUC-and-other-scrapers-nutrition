/**
 * The Telegram → GitHub relay. ~100 lines of policy on Cloudflare's free tier.
 *
 * ```
 *   Telegram ──webhook──▶ this Worker ──repository_dispatch──▶ Actions: tg-inbox.yml
 *                          (always on,                          (the whole existing
 *                           answers in ~50ms)                    inbox, unchanged)
 * ```
 *
 * ⚠️ **Why anything sits here at all.** Telegram cannot call GitHub directly:
 * `setWebhook` POSTs Telegram's own JSON to a fixed URL, and
 * `POST /repos/{repo}/dispatches` needs an `Authorization: Bearer` header and an
 * `{event_type, client_payload}` body, neither of which Telegram will send. And
 * Actions **cron** is not an alternative — free public repos are queued by ~3–3¾ h
 * (measured; see HANDOVER "Infrastructure truths"), which is the very latency this
 * exists to remove. `repository_dispatch` runs promptly. So the smallest thing that
 * can bridge the two is something always-on that speaks both, and that is all this
 * is: it holds no state, reads no Notion, and decides nothing about groceries.
 *
 * ⚠️ **It replaces the laptop's long poller, it does not join it.** A bot may have
 * a webhook OR serve `getUpdates`, never both — the exact trap `@Big_Notion_Bot`
 * set on 2026-08-10, where a poller on a webhooked bot gets `409 Conflict` on every
 * call and the chat simply looks dead. Registering this webhook stops the poller
 * working, so the Task Scheduler job must be disabled in the same sitting. See
 * `README.md` here for the order.
 *
 * ⚠️ **Everything answers 200 except a bad secret.** Telegram re-sends an update it
 * did not get a 2xx for, so a 500 on a malformed body means the same update arrives
 * again, and again — a retry loop that writes the same grocery row each time. The
 * failures worth reporting are reported *into the chat*, not through the status
 * code.
 *
 * Deploy: see `relay/README.md`. No build step, no dependencies, one file.
 */

const API = "https://api.telegram.org";
const GH = "https://api.github.com";

/** The event `tg-inbox.yml` listens for. Change both or neither. */
const EVENT_TYPE = "tgupdate";

const ok = () => new Response("ok", { status: 200 });

/**
 * One Bot API call, best-effort.
 *
 * ⚠️ **Nothing here may throw into the caller.** Every call this Worker makes to
 * Telegram is cosmetic — a spinner, a typing dot — and the dispatch that follows is
 * the part that matters. A relay that abandoned the dispatch because a spinner
 * failed would be fault 29 rebuilt at the edge.
 */
async function tg(doFetch, token, method, body) {
	try {
		const res = await doFetch(`${API}/bot${token}/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		if (!res.ok) console.error(`${method} HTTP ${res.status}`);
	} catch (e) {
		console.error(`${method} failed: ${e?.message ?? e}`);
	}
}

/** The chat an update belongs to, whichever kind it is. */
export function chatOf(update) {
	const id = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
	return id == null ? null : String(id);
}

/**
 * Handle one webhook delivery.
 *
 * `deps.fetch` is injectable so `worker.test.mjs` can drive the whole thing
 * offline — the outbound calls ARE the behaviour here, so a test that couldn't see
 * them would only be checking the status code.
 */
export async function handle(request, env, deps = {}) {
	const doFetch = deps.fetch ?? fetch;

	if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

	// ⚠️ The URL is the only thing standing between a stranger and this endpoint, so
	// the secret is not optional: an unset `WEBHOOK_SECRET` refuses everything rather
	// than accepting everything, which is the direction this mistake has to fail in.
	// `setWebhook`'s own `secret_token` is what puts the header on real deliveries.
	const secret = env.WEBHOOK_SECRET;
	if (!secret || request.headers.get("x-telegram-bot-api-secret-token") !== secret) {
		return new Response("unauthorized", { status: 401 });
	}

	let update;
	try {
		update = await request.json();
	} catch {
		console.error("unparseable body — dropped");
		return ok(); // 200: a body we can't read will not read any better on a retry
	}

	// The same allow-list the inbox itself applies, applied here too so a stranger's
	// message never costs an Actions run. Silence is deliberate: an unknown sender
	// must not learn that the bot is listening.
	if (chatOf(update) !== String(env.ALLOWED_CHAT_ID ?? "")) {
		console.error("update from another chat — dropped");
		return ok();
	}

	// Instant feedback, because the run this dispatches takes 20–60s to start and a
	// chat that does nothing for a minute is indistinguishable from a chat that is
	// broken — which is the complaint this whole change came from.
	if (update.callback_query) {
		// ⚠️ **Acking here is a fix, not just a nicety.** Telegram expires a callback
		// query id within about a minute, and fault 29 was exactly that expiry: the
		// tap was consumed, the ack threw, and the write never happened. Answered at
		// the edge in ~50ms, the id can no longer expire before someone answers it.
		// The Actions run's own `ack()` will then fail as already-answered, which it
		// already swallows by design.
		await tg(doFetch, env.TELEGRAM_BOT_TOKEN, "answerCallbackQuery", {
			callback_query_id: update.callback_query.id,
		});
	} else if (update.message?.text) {
		// Telegram clears this by itself after ~5s or when a message arrives, so it
		// cannot get stuck showing "typing" if the run fails.
		await tg(doFetch, env.TELEGRAM_BOT_TOKEN, "sendChatAction", {
			chat_id: update.message.chat.id,
			action: "typing",
		});
	}

	let dispatched = false;
	try {
		const res = await doFetch(`${GH}/repos/${env.REPO}/dispatches`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				// GitHub rejects an API call with no User-Agent.
				"User-Agent": "grocery-telegram-relay",
			},
			// One top-level property, `update`, holding Telegram's payload verbatim —
			// no reshaping here. This Worker is not a place where the meaning of an
			// update can drift; `tg-handle.ts` parses the real thing.
			body: JSON.stringify({ event_type: EVENT_TYPE, client_payload: { update } }),
		});
		// 204 No Content is the success case for this endpoint.
		dispatched = res.ok;
		if (!res.ok) console.error(`dispatch HTTP ${res.status}`);
	} catch (e) {
		console.error(`dispatch failed: ${e?.message ?? e}`);
	}

	// ⚠️ **A failed dispatch must be audible.** This is the one failure that would
	// otherwise reproduce the original complaint precisely — message sent, nothing
	// happens, no way to tell whether anyone heard it. Cloudflare's log is not
	// somewhere the user is standing.
	if (!dispatched) {
		await tg(doFetch, env.TELEGRAM_BOT_TOKEN, "sendMessage", {
			chat_id: chatOf(update),
			text: "⚠️ I got that, but couldn't reach GitHub to process it. Please send it again in a minute.",
		});
	}

	return ok();
}

export default {
	fetch: (request, env) => handle(request, env),
};
