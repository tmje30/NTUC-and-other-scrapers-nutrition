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
	/** The shopping page. Derived from `siteUrl` so the four places that link it agree. */
	listUrl: () => `${config.siteUrl().replace(/\/+$/, "")}/list.html`,
	/**
	 * "owner/repo" — where the Add button files its request. Actions sets
	 * GITHUB_REPOSITORY for free; the default keeps local page builds working.
	 */
	repo: () => optional("GITHUB_REPOSITORY", "tmje30/NTUC-and-other-scrapers-nutrition"),
	/**
	 * The relay's `/add` endpoint — where every one-tap button on the deals, review and
	 * history pages sends its dispatch.
	 *
	 * Derived from the relay's own host like `listEndpoint`, rather than configured twice,
	 * so the pages and the Worker cannot drift apart. Overridable for a fork or a local
	 * `wrangler dev`.
	 *
	 * ⚠️ **Set on its own this does nothing**, by design: one-tap needs `addSecret` too, or
	 * the page would send `X-Add-Secret: undefined` at the relay and have every tap
	 * refused. See `relayOneTap`.
	 */
	addEndpoint: () =>
		optional("ADD_ENDPOINT", "https://grocery-telegram-relay.tmje30.workers.dev/add"),
	/**
	 * The secret those pages send as `X-Add-Secret`, matching the relay's `ADD_SECRET`.
	 *
	 * ⚠️⚠️ **Baked into PUBLIC pages**, the second secret in this file to be so after
	 * `listSecret`, and the same deliberate trade: one-tap that needs nothing enabled per
	 * device cannot keep a credential private on a static page. It replaced a fine-grained
	 * PAT held in each browser's localStorage, which expired on 2026-10-26 and silently
	 * demoted every button to two taps for a fortnight. What it grants is narrow — the
	 * three events in the relay's `ADD_EVENTS` — and notably NOT the repo write that PAT
	 * carried.
	 *
	 * ⚠️ **`optional`, and unset must stay harmless**: a build without it renders pages
	 * whose buttons still work by the GitHub-issue link, exactly as they did before the
	 * relay existed. Local previews are built this way all the time.
	 */
	addSecret: () => optional("ADD_SECRET"),
	/**
	 * The relay's `/list` endpoint — where `list.html` sends a tick or an amount.
	 *
	 * Derived from the relay's own host rather than configured twice, so the page and the
	 * Worker cannot drift apart. Overridable for a fork or a local `wrangler dev`.
	 */
	listEndpoint: () =>
		optional("LIST_ENDPOINT", "https://grocery-telegram-relay.tmje30.workers.dev/list"),
	/**
	 * The secret `list.html` sends as `X-List-Secret`, matching the Worker's `LIST_SECRET`.
	 *
	 * ⚠️⚠️ **This one is BAKED INTO A PUBLIC PAGE, unlike every other secret here.** That is
	 * the deliberate trade behind "works on any device with nothing to enable" (user,
	 * 2026-09-11): a static page on GitHub Pages cannot hold a credential and hide it. What
	 * it grants is narrow — tick, untick and amount, on one grocery list — and notably NOT
	 * the repo write that the per-browser PAT it replaced carried.
	 *
	 * ⚠️ **`optional`, and unset must stay harmless.** A build with no value renders the page
	 * read-only rather than shipping `X-List-Secret: undefined` at the relay; see
	 * `renderListPage`. Local previews are built this way all the time.
	 */
	listSecret: () => optional("LIST_SECRET"),
	/**
	 * Public URL of `data/list-live.json` — the snapshot `list.html` fetches on load so a
	 * texted item appears without waiting for the next site build. See `ListFragment`.
	 *
	 * ⚠️ **`raw.githubusercontent`, deliberately, and not the Pages site.** A file on Pages
	 * only exists once `daily.yml` has deployed, which is the ~4-minute scan this is meant
	 * to skip; `raw` serves whatever is on the branch seconds after the inbox pushes it, and
	 * sends `Access-Control-Allow-Origin: *` so the page may read it cross-origin (both
	 * checked 2026-10-01). It caches for 300 s, which the page defeats with a `?t=`.
	 *
	 * ⚠️ The branch is in the URL and `main` is this repo's. A fork on another default
	 * branch sets `LIST_LIVE_URL` rather than editing this.
	 */
	listLiveUrl: () =>
		optional("LIST_LIVE_URL", `https://raw.githubusercontent.com/${config.repo()}/main/data/list-live.json`),
	/**
	 * Claude API key, for the macro lookup behind "Add to Ingredients".
	 * `optional` on purpose: unset simply means the new row is written without
	 * nutrition figures, which is a worse row but still a correct one. Only the
	 * macro lookup should ever fail for want of this — never an add.
	 */
	anthropicKey: () => optional("ANTHROPIC_API_KEY"),
};
