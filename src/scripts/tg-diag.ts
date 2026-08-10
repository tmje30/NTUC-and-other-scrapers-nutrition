import { config } from "../core/config.js";
import { callTelegram, useBotToken } from "../core/telegram.js";

/**
 * Why isn't the Telegram inbox seeing my messages? — `npm run tg-diag`
 *
 * Read-only. It sends nothing, acknowledges nothing, and changes nothing; the
 * `getUpdates` peek uses `offset: 0`, which looks at the queue WITHOUT marking
 * anything as delivered, so running this can never eat a message the poller
 * hasn't handled yet.
 *
 * ⚠️ **The failure it exists for is the 409.** A Telegram bot can have a webhook
 * OR serve `getUpdates`, never both. The user's outbound bot `@Big_Notion_Bot`
 * has a webhook pointing at their deployed Notion Worker, so a poller on that
 * token gets `409 Conflict` on every call and the chat simply looks dead —
 * messages arrive, nothing happens, nothing is logged anywhere the user sees.
 * That cost a confusing "I wrote the list and nothing happened" on 2026-08-10.
 *
 * If this prints a webhook URL, the fix is a SECOND bot in
 * `TELEGRAM_INBOX_BOT_TOKEN` — never `deleteWebhook`, which would silently break
 * whatever that webhook feeds.
 */

const usingInbox = Boolean(process.env.TELEGRAM_INBOX_BOT_TOKEN);
useBotToken(config.telegramInboxBotToken());

const me = await callTelegram<any>("getMe", {});
console.log(`bot          : @${me.username} (${me.first_name})`);
console.log(`token source : ${usingInbox ? "TELEGRAM_INBOX_BOT_TOKEN" : "TELEGRAM_BOT_TOKEN (no inbox bot set)"}`);
console.log(`chat id      : ${config.telegramChatId()}`);

const hook = await callTelegram<any>("getWebhookInfo", {});
console.log(`webhook      : ${hook.url || "(none — getUpdates will work)"}`);
if (hook.pending_update_count) console.log(`pending      : ${hook.pending_update_count}`);
if (hook.last_error_message) console.log(`last error   : ${hook.last_error_message}`);

if (hook.url) {
	console.log(
		`\n⚠️  This bot has a webhook, so getUpdates is refused with 409 and the\n` +
			`    poller will never see anything. Register a SECOND bot with @BotFather\n` +
			`    and put its token in TELEGRAM_INBOX_BOT_TOKEN.\n` +
			`    Do NOT deleteWebhook — that is a live delivery path for another app.`,
	);
	process.exit(1);
}

// offset 0 peeks without acknowledging — see the note above.
const ups = await callTelegram<any[]>("getUpdates", { offset: 0, timeout: 0, limit: 10 });
console.log(`\nqueued       : ${ups.length} update(s)`);
const allowed = String(config.telegramChatId());
for (const u of ups) {
	const chat = String(u.message?.chat?.id ?? u.callback_query?.message?.chat?.id ?? "?");
	const kind = u.message ? "message" : u.callback_query ? "button tap" : "other";
	const text = u.message?.text ? ` ${JSON.stringify(u.message.text.slice(0, 50))}` : "";
	// A chat mismatch is the second-most-likely cause of "nothing happened":
	// `pumpOnce` drops anything from another chat in silence, by design.
	const flag = chat === allowed ? "" : `  ← IGNORED, chat ${chat} != ${allowed}`;
	console.log(`  ${u.update_id}: ${kind}${text}${flag}`);
}
if (!ups.length) console.log("  (nothing waiting — text the bot, then run this again)");
