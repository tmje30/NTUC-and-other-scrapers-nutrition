import { config } from "../core/config.js";
import { callTelegram, useBotToken } from "../core/telegram.js";

/**
 * Point this project's bot at the Cloudflare relay — or show/undo it.
 *
 *   npm run tg-webhook                          # show what is registered now
 *   npm run tg-webhook -- set <url> <secret>    # register the relay
 *   npm run tg-webhook -- delete                # go back to long-polling
 *
 * A script rather than a `curl` line because the bot token would otherwise sit in
 * shell history, and because of the guard below.
 *
 * ⚠️ **A bot has a webhook OR serves `getUpdates`, never both.** Registering one
 * stops `npm run tg-poll` working — every call gets `409 Conflict` and the chat
 * simply looks dead. That is the point when this is used deliberately, and a trap
 * when it is not: disable the "Grocery Telegram Inbox" scheduled task in the same
 * sitting. See `relay/README.md`.
 *
 * ⚠️ **`delete` must never be run against `@Big_Notion_Bot`.** That bot's webhook is
 * the only delivery path the user's Notion Worker has, in a different project, and
 * removing it breaks that worker silently. `TELEGRAM_INBOX_BOT_TOKEN` falls back to
 * `TELEGRAM_BOT_TOKEN`, so a mis-set `.env` could genuinely point this script at it —
 * hence the refusal below, which is checked against the live bot's own name rather
 * than against which variable the token came from.
 */

const BANNED = ["big_notion_bot"];

const [verb = "show", url, secret] = process.argv.slice(2);

useBotToken(config.telegramInboxBotToken());

const me = await callTelegram<{ username: string; first_name: string }>("getMe", {});
console.error(`bot: @${me.username} (${me.first_name})`);

if (BANNED.includes(me.username.toLowerCase())) {
	console.error(
		`\nRefusing to touch @${me.username}. Its webhook is another project's only\n` +
			`delivery path (the Notion Worker), and this script would break it silently.\n` +
			`Set TELEGRAM_INBOX_BOT_TOKEN to this project's own bot and try again.`,
	);
	process.exit(1);
}

if (verb === "show") {
	const info = await callTelegram<Record<string, unknown>>("getWebhookInfo", {});
	console.error(info.url ? `webhook: ${info.url}` : "webhook: (none — getUpdates will work)");
	if (info.pending_update_count) console.error(`pending: ${info.pending_update_count} update(s)`);
	if (info.last_error_message) {
		// The single most useful line when the relay is deployed but nothing arrives.
		console.error(`last error: ${info.last_error_message} (at ${info.last_error_date})`);
	}
	process.exit(0);
}

if (verb === "delete") {
	// ⚠️ `drop_pending_updates` is deliberately NOT set: anything Telegram is holding
	// should still be delivered to whatever listens next, not thrown away.
	await callTelegram("deleteWebhook", {});
	console.error("Webhook removed. `npm run tg-poll` will work again.");
	process.exit(0);
}

if (verb !== "set" || !url || !secret) {
	console.error("\nusage: npm run tg-webhook -- set <https-url> <secret>   |   delete   |   show");
	process.exit(2);
}

if (!url.startsWith("https://")) {
	console.error("Telegram only accepts an HTTPS webhook URL.");
	process.exit(2);
}

await callTelegram("setWebhook", {
	url,
	// Becomes the `X-Telegram-Bot-Api-Secret-Token` header on every delivery, and is
	// the only thing stopping a stranger who guesses the URL from posting updates.
	// Must match the Worker's WEBHOOK_SECRET exactly.
	secret_token: secret,
	// The same two the poller asked for. Narrowing this is not just tidiness: an
	// update type nobody handles still costs an Actions run.
	allowed_updates: ["message", "callback_query"],
	// A retry of a delivery we already handled would re-run the whole update, and the
	// grocery list's title dedupe is the only thing absorbing that. One is enough.
	max_connections: 1,
});
console.error(`Webhook set → ${url}`);
console.error("⚠️  `npm run tg-poll` will now 409. Disable the 'Grocery Telegram Inbox' task.");
