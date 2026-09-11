/**
 * Tests for the relay. Plain Node, no TypeScript, no dependencies — the Worker is
 * outside `tsconfig.json`'s `rootDir`, so it gets its own tiny harness rather than
 * dragging the whole project's build layout around to accommodate one file.
 *
 * Run via `npm test`, which chains this after the main suite.
 *
 * Every outbound call is captured rather than made: the calls ARE the behaviour
 * here, and a test that only looked at the status code would pass on a relay that
 * dispatched nothing.
 */
import { handle, scheduled } from "./worker.mjs";

let passed = 0;
const failures = [];

function eq(name, actual, expected) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) passed++;
	else failures.push(`${name}\n    expected ${e}\n    got      ${a}`);
}

function check(name, cond) {
	if (cond) passed++;
	else failures.push(name);
}

const ENV = {
	WEBHOOK_SECRET: "s3cret",
	TELEGRAM_BOT_TOKEN: "bot-token",
	GITHUB_TOKEN: "gh-token",
	ALLOWED_CHAT_ID: "7626546412",
	REPO: "tmje30/NTUC-and-other-scrapers-nutrition",
	// What `list.html` sends as `X-List-Secret`. Public in the page by design — see
	// `handleList` in the Worker for why, and for what it does not buy an attacker.
	LIST_SECRET: "list-s3cret",
};

/** A recording fetch. `fail` names a URL substring that should answer non-2xx. */
function recorder({ fail = null } = {}) {
	const calls = [];
	const fn = async (url, init) => {
		calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, headers: init?.headers ?? {} });
		const bad = fail && url.includes(fail);
		return { ok: !bad, status: bad ? 500 : 200 };
	};
	fn.calls = calls;
	fn.methods = () => calls.map((c) => c.url.split("/").pop());
	return fn;
}

const post = (body, { secret = "s3cret" } = {}) =>
	new Request("https://relay.example/", {
		method: "POST",
		headers: secret == null ? {} : { "x-telegram-bot-api-secret-token": secret },
		body: JSON.stringify(body),
	});

const textUpdate = (chatId = 7626546412) => ({
	update_id: 1,
	message: { message_id: 9, chat: { id: chatId }, text: "2kg chicken breast" },
});

const tapUpdate = (chatId = 7626546412) => ({
	update_id: 2,
	callback_query: { id: "cbq-1", data: "p:abc123:0", message: { message_id: 37, chat: { id: chatId } } },
});

// ── the secret ───────────────────────────────────────────────────────────────
{
	const f = recorder();
	const res = await handle(post(textUpdate(), { secret: "wrong" }), ENV, { fetch: f });
	eq("a wrong secret is refused", res.status, 401);
	eq("…and nothing is called", f.calls.length, 0);
}
{
	const f = recorder();
	const res = await handle(post(textUpdate(), { secret: null }), ENV, { fetch: f });
	eq("a missing secret header is refused", res.status, 401);
}
{
	// ⚠️ The direction this mistake has to fail in: no configured secret refuses
	// everything rather than accepting everything.
	const f = recorder();
	const res = await handle(post(textUpdate()), { ...ENV, WEBHOOK_SECRET: "" }, { fetch: f });
	eq("an unconfigured secret refuses everything", res.status, 401);
	eq("…and still calls nothing", f.calls.length, 0);
}

// ── a texted list ────────────────────────────────────────────────────────────
{
	const f = recorder();
	const res = await handle(post(textUpdate()), ENV, { fetch: f });
	eq("a good text is accepted", res.status, 200);
	eq("it types, then dispatches", f.methods(), ["sendChatAction", "dispatches"]);

	const dispatch = f.calls[1];
	eq("the event type is the one the workflow listens for", dispatch.body.event_type, "tgupdate");
	// The update travels verbatim under one property — this relay is not a place
	// where the meaning of an update may drift.
	eq("the update is passed through untouched", dispatch.body.client_payload.update, textUpdate());
	eq("the repo is the configured one", dispatch.url, "https://api.github.com/repos/tmje30/NTUC-and-other-scrapers-nutrition/dispatches");
	eq("it authenticates as the PAT", dispatch.headers.Authorization, "Bearer gh-token");
	check("and sends a User-Agent, which GitHub requires", Boolean(dispatch.headers["User-Agent"]));
}

// ── a button tap ─────────────────────────────────────────────────────────────
{
	const f = recorder();
	await handle(post(tapUpdate()), ENV, { fetch: f });
	// ⚠️ Acking at the edge is the fault-29 fix: Telegram expires a callback id in
	// about a minute and the Actions run takes 20–60s to start, so the ack cannot
	// wait for it.
	eq("a tap is acked first, then dispatched", f.methods(), ["answerCallbackQuery", "dispatches"]);
	eq("the ack names the query", f.calls[0].body.callback_query_id, "cbq-1");
	eq("the tap is dispatched too", f.calls[1].body.client_payload.update.callback_query.data, "p:abc123:0");
}

// ── the chat allow-list ──────────────────────────────────────────────────────
{
	const f = recorder();
	const res = await handle(post(textUpdate(99)), ENV, { fetch: f });
	eq("another chat's message is dropped", res.status, 200);
	// Silence, not a refusal: a stranger must not learn the bot is listening, and
	// must not cost an Actions run either.
	eq("…in complete silence", f.calls.length, 0);
}
{
	const f = recorder();
	await handle(post(tapUpdate(99)), ENV, { fetch: f });
	eq("another chat's TAP is dropped too", f.calls.length, 0);
}

// ── failures ─────────────────────────────────────────────────────────────────
{
	const f = recorder({ fail: "dispatches" });
	const res = await handle(post(textUpdate()), ENV, { fetch: f });
	// 200 even though the dispatch failed: a non-2xx makes Telegram re-send the same
	// update, which writes the same grocery row again.
	eq("a failed dispatch still answers 200", res.status, 200);
	eq("and the failure is said out loud, in the chat", f.methods(), [
		"sendChatAction",
		"dispatches",
		"sendMessage",
	]);
	check(
		"…naming GitHub as the thing that failed",
		f.calls[2].body.text.includes("couldn't reach GitHub"),
	);
	eq("…to the right chat", f.calls[2].body.chat_id, "7626546412");
}
{
	// A cosmetic Telegram call failing must not cost the dispatch — that is fault 29
	// rebuilt at the edge.
	const f = recorder({ fail: "sendChatAction" });
	await handle(post(textUpdate()), ENV, { fetch: f });
	check("a failed typing indicator does not stop the dispatch", f.methods().includes("dispatches"));
}
{
	const f = recorder();
	const req = new Request("https://relay.example/", {
		method: "POST",
		headers: { "x-telegram-bot-api-secret-token": "s3cret" },
		body: "{not json",
	});
	const res = await handle(req, ENV, { fetch: f });
	eq("an unreadable body is swallowed, not retried forever", res.status, 200);
	eq("…and nothing is dispatched", f.calls.length, 0);
}
{
	const f = recorder();
	const res = await handle(new Request("https://relay.example/", { method: "GET" }), ENV, { fetch: f });
	eq("a GET is not a webhook delivery", res.status, 405);
}

/**
 * The cron tick — the clock for the one-hour auto-file.
 *
 * ⚠️ **Nothing else in the cloud watches that clock.** GitHub's own `schedule:` is
 * queued by hours on a free public repo, so if this tick stops dispatching, questions
 * simply stop being filed and no run fails to say so. That makes "it dispatches
 * `tgsweep`, and it does not talk to Telegram" worth pinning down.
 */
{
	const f = recorder();
	await scheduled({ cron: "*/15 * * * *" }, ENV, { fetch: f });
	eq("the cron tick dispatches, and only that", f.methods(), ["dispatches"]);
	eq("…as tgsweep", f.calls[0].body.event_type, "tgsweep");
	check("…to the right repo", f.calls[0].url.includes(ENV.REPO));
	check("…authenticated", f.calls[0].headers.Authorization === `Bearer ${ENV.GITHUB_TOKEN}`);
	// GitHub refuses an API call with no User-Agent — the same trap the update path hit.
	check("…with a User-Agent", Boolean(f.calls[0].headers["User-Agent"]));
}
{
	// ⚠️ A failed tick is deliberately SILENT in the chat. It fires 96 times a day, so
	// a chat message on failure would be four an hour for ever — the alert you mute,
	// and then miss a real one behind. `wrangler tail` is where this one is visible.
	const f = recorder({ fail: "dispatches" });
	await scheduled({ cron: "*/15 * * * *" }, ENV, { fetch: f });
	eq("a failed tick does not message the chat", f.methods(), ["dispatches"]);
}
{
	// It must not throw either: an unhandled rejection in a scheduled handler is a
	// Cloudflare error with no chat and no Actions run to show for it.
	const boom = async () => {
		throw new Error("network down");
	};
	let threw = false;
	try {
		await scheduled({ cron: "*/15 * * * *" }, ENV, { fetch: boom });
	} catch {
		threw = true;
	}
	check("a thrown fetch is swallowed", !threw);
}

// ── POST /list — the shopping page ───────────────────────────────────────────
//
// ⚠️ This endpoint is reachable by anyone who opens the (public) page, so the tests
// that matter most are the refusals. What it CAN do is narrow by design; what it
// must never do is widen.

const listReq = (body, { secret = "list-s3cret", method = "POST" } = {}) =>
	new Request("https://relay.example/list", {
		method,
		headers: secret == null ? {} : { "X-List-Secret": secret, "Content-Type": "application/json" },
		body: method === "POST" ? JSON.stringify(body) : undefined,
	});

const TICK = { op: "tick", pageId: "3d469a18-4fe7-802f-8620-000b6053908d" };

{
	const f = recorder();
	const res = await handle(listReq(TICK), ENV, { fetch: f });
	eq("a tick is accepted", res.status, 200);
	eq("…and dispatched once", f.calls.length, 1);
	eq("…at the repo's dispatches endpoint", f.calls[0].url.endsWith("/dispatches"), true);
	eq("…as a list-action", f.calls[0].body.event_type, "list-action");
	// Nested under `payload`, matching what `list-action.ts` unwraps.
	eq("…with the payload nested", f.calls[0].body.client_payload.payload.op, "tick");
}

{
	// ⚠️ A WRONG secret must not dispatch. This is the whole gate.
	const f = recorder();
	const res = await handle(listReq(TICK, { secret: "wrong" }), ENV, { fetch: f });
	eq("a wrong secret is refused", res.status, 401);
	eq("…and dispatches nothing", f.calls.length, 0);
}

{
	const f = recorder();
	const res = await handle(listReq(TICK, { secret: null }), ENV, { fetch: f });
	eq("no secret at all is refused", res.status, 401);
	eq("…and dispatches nothing", f.calls.length, 0);
}

{
	// ⚠️⚠️ An UNSET LIST_SECRET must refuse everything, not accept everything — the same
	// direction WEBHOOK_SECRET fails in. A relay deployed before the secret was set would
	// otherwise be an open door.
	const f = recorder();
	const res = await handle(listReq(TICK), { ...ENV, LIST_SECRET: undefined }, { fetch: f });
	eq("an unset LIST_SECRET refuses everything", res.status, 401);
	eq("…and dispatches nothing", f.calls.length, 0);
}

{
	// ⚠️ A malformed tap is refused at the edge rather than spending an Actions run to
	// discover the same thing in the repo.
	const f = recorder();
	const res = await handle(listReq({ op: "rm -rf", pageId: TICK.pageId }), ENV, { fetch: f });
	eq("an unknown op is refused", res.status, 400);
	eq("…and dispatches nothing", f.calls.length, 0);
}

{
	const f = recorder();
	const res = await handle(listReq({ op: "tick", pageId: "not-an-id" }), ENV, { fetch: f });
	eq("a bad page id is refused", res.status, 400);
	eq("…and dispatches nothing", f.calls.length, 0);
}

{
	// The browser preflights every call, because X-List-Secret is a custom header.
	const f = recorder();
	const res = await handle(listReq(null, { method: "OPTIONS" }), ENV, { fetch: f });
	eq("the CORS preflight is answered", res.status, 204);
	eq("…allowing the secret header", res.headers.get("Access-Control-Allow-Headers").includes("X-List-Secret"), true);
	eq("…and dispatching nothing", f.calls.length, 0);
}

{
	// ⚠️ A real status, unlike the Telegram path's unconditional 200: nothing retries a
	// checkbox, so the page has to be able to put the tick back.
	const f = recorder({ fail: "dispatches" });
	const res = await handle(listReq(TICK), ENV, { fetch: f });
	eq("a refused dispatch is reported, not swallowed", res.status, 502);
	const body = await res.json();
	eq("…with ok:false", body.ok, false);
}

{
	// CORS headers must be on the real answers too, or the page cannot read the status.
	const f = recorder();
	const res = await handle(listReq(TICK), ENV, { fetch: f });
	eq("the success answer is readable cross-origin", res.headers.get("Access-Control-Allow-Origin"), "*");
}

{
	// ⚠️ The Telegram path must be untouched by any of this — its allow-list, its secret
	// header and its unconditional 200 all intact.
	const f = recorder();
	const res = await handle(
		new Request("https://relay.example/", {
			method: "POST",
			headers: { "x-telegram-bot-api-secret-token": "s3cret" },
			body: JSON.stringify({ message: { chat: { id: 7626546412 }, text: "milk" } }),
		}),
		ENV,
		{ fetch: f },
	);
	eq("a Telegram update still answers 200", res.status, 200);
	check("…and still dispatches tgupdate", f.calls.some((c) => c.body?.event_type === "tgupdate"));
}

// ── the midnight cron ────────────────────────────────────────────────────────

{
	// ⚠️⚠️ Both cron patterns match at 16:00 UTC and Cloudflare invokes the handler once
	// per pattern. The midnight one must send listsweep and NOT also send tgsweep, or a
	// grocery clear-out would double as a Telegram sweep.
	const f = recorder();
	await scheduled({ cron: "0 16 * * *" }, ENV, { fetch: f });
	eq("midnight sends exactly one dispatch", f.calls.length, 1);
	eq("…and it is listsweep", f.calls[0].body.event_type, "listsweep");
}

{
	// …while the quarter-hourly tick goes on doing the Telegram half, including the one
	// that lands in the very same minute as midnight.
	const f = recorder();
	await scheduled({ cron: "*/15 * * * *" }, ENV, { fetch: f });
	eq("a 15-minute tick sends tgsweep", f.calls[0].body.event_type, "tgsweep");
	check("…and never listsweep", !f.calls.some((c) => c.body?.event_type === "listsweep"));
}

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nrelay — Telegram → GitHub`);
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(failures.length ? `\n${failures.length} failed, ${passed} passed` : `all ${passed} passed`);
process.exit(failures.length ? 1 : 0);
