import { readFile } from "node:fs/promises";
import { sendSummary } from "../core/telegram.js";
import { config } from "../core/config.js";

/** Reads public/summary.json (from build-site) and sends the single Telegram message. */

const { count, warning } = JSON.parse(await readFile("public/summary.json", "utf8")) as {
	count: number;
	warning?: string;
};

// A warning earns a message even with no deals: a runner that has silently
// stopped working otherwise looks exactly like a quiet shopping day.
if (count > 0 || warning) {
	await sendSummary(count, config.siteUrl(), warning);
	console.error(`Sent summary: ${count} deals${warning ? ` — ${warning}` : ""} → ${config.siteUrl()}`);
} else {
	console.error("No deals today — no message sent.");
}
