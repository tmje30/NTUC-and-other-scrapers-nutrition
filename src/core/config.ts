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
	/** Which "Used 'N' Plan" column drives the alerts: "1" | "2" | "3". */
	activePlanNumber: () => optional("ACTIVE_PLAN_NUMBER", "1"),
	telegramBotToken: () => required("TELEGRAM_BOT_TOKEN"),
	telegramChatId: () => required("TELEGRAM_CHAT_ID"),
	/** Public URL of the deployed GitHub Pages deals page. */
	siteUrl: () =>
		optional("SITE_URL", "https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/"),
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
