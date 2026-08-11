import { COMMITTED_STATE_PATH, readState, writeState } from "../core/tg-inbox.js";

/**
 * Carry the laptop poller's outstanding questions into the committed state file,
 * once — the last step of moving the inbox to the webhook.
 *
 *   npm run tg-adopt-state
 *
 * ⚠️ **Run it AFTER the poller has stopped, never before.** While the poller is
 * alive it owns `.sessions/tg-inbox.json`: copy first and it will answer a tap,
 * update its own file, and leave this one holding a question that has already been
 * settled — which the cloud would then put back on screen with live buttons.
 *
 * ⚠️ **Why bother at all, for two questions?** Because the alternative is a chat
 * where the buttons still look live and no run has ever heard of their tokens. The
 * user taps, gets "That question has already been answered", and the item they were
 * asked about reaches no list. A question nobody can answer is worse than one that
 * was never asked.
 *
 * The offset is deliberately NOT carried: a webhook has no offset, and Telegram will
 * push whatever it is holding to the relay as soon as it is registered.
 */

const [from = ".sessions/tg-inbox.json"] = process.argv.slice(2);

const local = await readState(from);
const open = Object.entries(local.pending);

if (!open.length && !local.queue.length) {
	console.error(`${from}: nothing outstanding — nothing to carry over.`);
	process.exit(0);
}

// Merged into whatever is already committed rather than written over it, so running
// this twice cannot lose a question the cloud has since raised.
const committed = await readState(COMMITTED_STATE_PATH);
const queued = new Set(committed.queue.map((q) => q.raw));

await writeState(
	{
		offset: 0,
		pending: { ...committed.pending, ...local.pending },
		queue: [...committed.queue, ...local.queue.filter((q) => !queued.has(q.raw))],
	},
	COMMITTED_STATE_PATH,
);

for (const [t, ask] of open) console.error(`  carried ${t}: ${ask.item.raw}`);
console.error(
	`\nWrote ${COMMITTED_STATE_PATH} — ${open.length} question(s), ` +
		`${local.queue.length} item(s) queued for pricing.\n` +
		`Commit and push it, or the cloud starts from empty.`,
);
