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
import { handle } from "./worker.mjs";

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

// ── report ───────────────────────────────────────────────────────────────────
console.log(`\nrelay — Telegram → GitHub`);
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(failures.length ? `\n${failures.length} failed, ${passed} passed` : `all ${passed} passed`);
process.exit(failures.length ? 1 : 0);
