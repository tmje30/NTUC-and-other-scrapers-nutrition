import { config as loadEnv } from "dotenv";

// quiet: dotenv v17 otherwise prints a promo banner to stdout, which can corrupt
// piped output (it once got baked into a GitHub secret). Keep stdout clean.
loadEnv({ quiet: true });

/**
 * Central config, sourced from environment variables.
 * Locally these come from `.env` (gitignored); in CI from GitHub Actions secrets.
 * Runtime-agnostic — nothing here depends on the Notion Workers host.
 */

export function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`Missing required env var: ${name}`);
	return v;
}

export function optional(name: string, fallback = ""): string {
	return process.env[name] ?? fallback;
}

export const config = {
	notionToken: () => required("NOTION_TOKEN"),
	ingredientsDbId: () => optional("INGREDIENTS_DB_ID"),
	mealPrepDbId: () => optional("MEAL_PREP_DB_ID"),
	telegramBotToken: () => required("TELEGRAM_BOT_TOKEN"),
	telegramChatId: () => required("TELEGRAM_CHAT_ID"),
	/**
	 * The bot the INBOX poller listens on. Falls back to the outbound bot, which
	 * since 2026-08-10 is the NORMAL case, not a degraded one.
	 *
	 * This project now has a bot of its own — **@Grocery69_bot** — which both
	 * sends the daily digest and serves the poller. One bot can do both; what a
	 * bot cannot do is have a webhook AND serve `getUpdates`. So the split this
	 * variable was created for exists only if those two roles ever land on
	 * different bots again.
	 *
	 * ⚠️ **The trap it was created for, kept because it is still live.** The
	 * project used to send through the user's `@Big_Notion_Bot`, which has a
	 * webhook pointing at their deployed Notion Worker — that is how their
	 * calendar/notes bot receives anything at all. Polling that token returns
	 * `409 Conflict: can't use getUpdates method while webhook is active` on
	 * every call, and the chat simply looks dead: messages arrive, they go to
	 * Notion, and the poller sees nothing. Measured 2026-08-10 — "I wrote the
	 * list and nothing happened".
	 *
	 * ⚠️ **`deleteWebhook` on `@Big_Notion_Bot` is NEVER the fix, and nothing
	 * here may call it.** It is that worker's only delivery path, in a different
	 * project, and removing it breaks it silently. Register another bot instead.
	 *
	 * The chat id is the same whichever bot is used: `TELEGRAM_CHAT_ID` is
	 * positive, so it is a private chat, and a private chat's id IS the user's
	 * Telegram user id — identical for every bot they talk to.
	 */
	telegramInboxBotToken: () => optional("TELEGRAM_INBOX_BOT_TOKEN") || required("TELEGRAM_BOT_TOKEN"),
	/** Public URL of the deployed GitHub Pages deals page. */
	siteUrl: () =>
		optional("SITE_URL", "https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/"),
	/**
	 * The price-review page — every pick the vendor scan was unsure about, on one page.
	 * Derived from `siteUrl` rather than configured separately so the two cannot drift
	 * apart when the site moves.
	 */
	reviewUrl: () => `${config.siteUrl().replace(/\/+$/, "")}/review.html`,
	/** What the last sweep CHANGED in the price book. Derived from `siteUrl`, as above. */
	movesUrl: () => `${config.siteUrl().replace(/\/+$/, "")}/moves.html`,
	/**
	 * "owner/repo" — where the Add button files its request. Actions sets
	 * GITHUB_REPOSITORY for free; the default keeps local page builds working.
	 */
	repo: () => optional("GITHUB_REPOSITORY", "tmje30/NTUC-and-other-scrapers-nutrition"),
	/**
	 * Optional one-tap Add endpoint (the Cloudflare Worker in `cloudflare/`).
	 * Unset — the normal case — makes Add open a pre-filled GitHub issue instead.
	 */
	addEndpoint: () => optional("ADD_ENDPOINT"),
	/**
	 * Claude API key, for the macro lookup behind "Add to Ingredients".
	 * `optional` on purpose: unset simply means the new row is written without
	 * nutrition figures, which is a worse row but still a correct one. Only the
	 * macro lookup should ever fail for want of this — never an add.
	 */
	anthropicKey: () => optional("ANTHROPIC_API_KEY"),
};
