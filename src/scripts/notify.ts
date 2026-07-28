import { readFile } from "node:fs/promises";
import { sendSummary } from "../core/telegram.js";
import { config } from "../core/config.js";

/** Reads public/summary.json (from build-site) and sends the single Telegram message. */

const { count } = JSON.parse(await readFile("public/summary.json", "utf8")) as { count: number };
if (count > 0) {
	await sendSummary(count, config.siteUrl());
	console.error(`Sent summary: ${count} deals → ${config.siteUrl()}`);
} else {
	console.error("No deals today — no message sent.");
}
