import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Client } from "@notionhq/client";
import { config } from "./config.js";
import {
	answerCallback,
	editHtml,
	escapeHtml as esc,
	getUpdates,
	sendHtml,
	type InlineKeyboard,
	type TgUpdate,
} from "./telegram.js";
import { parseList, sizeLabel, type ParsedItem } from "./list-parse.js";
import {
	decideList,
	pricePerKgLabelFor,
	readIngredientRows,
	type IngredientRow,
	type RowMatch,
} from "./list-intake.js";
import { addTextedItem } from "./grocery-list.js";
import { categorize } from "./categorize.js";
import {
	createIngredient,
	describeSlotDecision,
	recordVendorPrice,
	type IngredientFields,
} from "./ingredient-write.js";
import { readVendorReview, writeVendorReview } from "./vendor-review-file.js";
import { withRejectedPick, withoutPending } from "./vendor-review.js";
import { unparkIngredient } from "./park.js";
import { PARKED_TAG } from "./notion.js";
import { scanNewItems, type NewItemResult } from "./new-items.js";

/**
 * The Telegram inbox: text a grocery list, get it filed into Notion.
 *
 * ```
 *   "2kg chicken breast          parse → match → ┬─ known  → write the grocery-list row
 *    1L milk                                     ├─ unsure → ask, with buttons
 *    harissa paste"                              └─ new    → scan the shops, publish a page
 * ```
 *
 * ⚠️ **This is the first inbound path in the project.** Everything before it was
 * outbound (a daily digest) or a button on a static page that routed through a
 * GitHub issue. So it is also the first place where something the user typed
 * reaches a Notion write, and the guards below exist for that reason:
 *
 *  • **Chat allow-list.** The bot token is shared with the user's Notion Worker
 *    bot. Anything from a chat other than the configured one is dropped without
 *    a reply — an unknown sender must not be able to write to the grocery list,
 *    and must not learn that the bot is listening either.
 *  • **The offset is persisted AFTER handling, not before.** Telegram treats a
 *    fetch at an offset as an acknowledgement of everything before it, so
 *    advancing early loses a message on a crash and never advancing replays it
 *    forever. A crash mid-batch therefore re-runs the batch, which the grocery
 *    list's own title dedupe absorbs (`findOpenRow`).
 *  • **Nothing here starts a paid lookup.** No macro call, no model call. See
 *    "Nothing spends money unasked" in HANDOVER — a texted list is exactly the
 *    kind of ordinary action that must not quietly cost 40 cents.
 */

/**
 * Machine-local, gitignored — the long-polling laptop's own copy (`.sessions/`
 * holds session-shaped state already).
 */
const STATE_PATH = ".sessions/tg-inbox.json";

/**
 * The webhook flow's state, **committed to the repo**.
 *
 * ⚠️ **A webhook has no process to hold state in.** Every update is a fresh
 * Actions run on a fresh checkout, so a pending question that lives in memory or
 * in `.sessions/` is a question the user answers into the void — they tap, the run
 * that reads the tap has never heard of the token, and it replies "already
 * answered" about something nobody answered. The repo is the only store both the
 * cloud and the laptop can see, which is the same reasoning that put
 * `vendor-review.json` here (see `vendor-review-file.ts`).
 *
 * ⚠️ **The repo is PUBLIC.** What lands here is grocery-item text, Ingredients row
 * names and Notion page ids — the same class of thing `vendor-review.json` has
 * committed since 2026-08-11. A page id is not a credential (it is useless without
 * the integration token) but it is not nothing either: keep tokens, chat contents
 * and anything from another chat out of this file.
 */
export const COMMITTED_STATE_PATH = "data/tg-inbox-state.json";

/** One row on offer, as it sits on the keyboard. */
export interface AskCandidate {
	rowId: string;
	rowName: string;
	score: number;
	/** Tagged `Not in Use ATM` — shown with a 💤, and un-parked if picked. */
	parked?: boolean;
}

/** One question awaiting a tap. */
interface PendingAsk {
	item: ParsedItem;
	/** The rows currently on the keyboard, in button order. */
	candidates: AskCandidate[];
	/**
	 * ⚠️ There is no `rejected` list any more (2026-08-11). It existed so
	 * re-search would not offer a row the user had already passed over; with that
	 * button gone, the candidates on the keyboard are the whole offer and nothing
	 * needs remembering. Old state files may still carry the field — harmless,
	 * since nothing reads it.
	 */
	/** The prompt message, so its buttons can be replaced with the outcome. */
	messageId: number;
	chatId: number;
	/**
	 * When the question was sent, ISO — the start of the one-hour clock.
	 *
	 * ⚠️ **The type says `string`; a state file written before 2026-08-12 has
	 * none.** `readState` casts unvalidated JSON, so this field can genuinely be
	 * `undefined` at runtime on an ask that predates the auto-file. `expiredAsks`
	 * therefore checks for it rather than trusting the type — see the note there on
	 * why a missing timestamp starts the clock instead of firing it.
	 */
	askedAt: string;
	/**
	 * Whether the shop scan must wait for this answer.
	 *
	 * ⚠️ A **near-miss** blocks: until it is answered we do not know whether the
	 * item is new at all, and scanning the shops for something that turns out to be
	 * the milk you already buy is wasted work on a page nobody wants. An offer on
	 * an item already ruled **new** does not block — it is only asking whether to
	 * file it, and holding a whole batch's pricing behind an optional question is
	 * how the new-items page would stop appearing.
	 */
	blocking: boolean;
	/** Set once the user has asked to create a row and been shown what that means. */
	awaitingCreate?: boolean;
}

export interface InboxState {
	/** Next `getUpdates` offset — always `last update_id + 1`. */
	offset: number;
	pending: Record<string, PendingAsk>;
	/** New items accumulated across a batch, scanned once nothing is pending. */
	queue: ParsedItem[];
}

const EMPTY_STATE: InboxState = { offset: 0, pending: {}, queue: [] };

/**
 * On disk the asks are an **array**, not the map they are in memory.
 *
 * ⚠️ **Because two Actions runs can write this file at once**, and the only merger
 * this project has — `merge-data.ts`, built for exactly that collision and proven
 * against the real 06:17 one — merges *lists* identified by a key. A JSON object
 * keyed by token would need a second merger with its own bugs. So the token moves
 * from the key into the entry, and `asks` merges like every other data file.
 */
interface StoredAsk extends PendingAsk {
	token: string;
}

/** The committed/on-disk shape. `updatedAt` is what `mergeDataFile` compares. */
interface StoredState {
	version: 1;
	updatedAt: string;
	offset: number;
	asks: StoredAsk[];
	queue: ParsedItem[];
}

export async function readState(path = STATE_PATH): Promise<InboxState> {
	try {
		const raw = JSON.parse(await readFile(path, "utf8"));
		const pending: Record<string, PendingAsk> = {};
		// The array shape, as written below.
		for (const a of Array.isArray(raw?.asks) ? raw.asks : []) {
			if (a?.token) {
				const { token: t, ...ask } = a;
				pending[t] = ask as PendingAsk;
			}
		}
		// ⚠️ And the ORIGINAL map shape, still read. The laptop poller's live
		// `.sessions/tg-inbox.json` is in it, and a reader that silently forgot every
		// outstanding question on upgrade would strand whatever was on screen at the
		// time — which is precisely the failure this state exists to prevent.
		if (raw?.pending && typeof raw.pending === "object") {
			for (const [t, ask] of Object.entries(raw.pending)) {
				if (ask && typeof ask === "object") pending[t] = ask as PendingAsk;
			}
		}
		return {
			offset: Number(raw?.offset) || 0,
			pending,
			queue: Array.isArray(raw?.queue) ? raw.queue : [],
		};
	} catch {
		return { ...EMPTY_STATE };
	}
}

export async function writeState(state: InboxState, path = STATE_PATH): Promise<void> {
	const dir = dirname(path);
	if (dir && dir !== ".") await mkdir(dir, { recursive: true });
	const stored: StoredState = {
		version: 1,
		updatedAt: new Date().toISOString(),
		offset: state.offset,
		asks: Object.entries(state.pending).map(([token, ask]) => ({ token, ...ask })),
		queue: state.queue,
	};
	// Pretty-printed, unlike the machine-local file it replaces: this one lands in
	// git, and a one-line JSON blob makes every diff unreadable.
	await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
}

/**
 * A short opaque token for a button.
 *
 * Telegram caps `callback_data` at 64 bytes, so the ask itself is held in the
 * state file and only this key travels. Collisions are avoided by checking the
 * live pending map rather than by making the token long — there are never more
 * than a handful outstanding.
 */
function token(pending: Record<string, PendingAsk>): string {
	let t = "";
	do {
		t = Math.random().toString(36).slice(2, 8);
	} while (pending[t]);
	return t;
}

const HELP =
	"🛒 <b>Text me your grocery list</b>\n" +
	"One item per line, or comma-separated. Quantities optional:\n" +
	"<code>2kg chicken breast\n1L milk\nbananas x6\nharissa paste</code>\n\n" +
	"I'll match each line to your Ingredients DB and add it to the grocery List " +
	"with its price. Anything I'm unsure about I'll ask. Anything new, I'll price " +
	"at the shops and send you a page.";

/** Format one written row for the reply. */
function wroteLine(name: string, count: number, price?: string): string {
	const qty = count > 1 ? ` ×${count}` : "";
	return `✅ ${esc(name)}${qty}${price ? ` · ${esc(price)}` : ""}`;
}

/**
 * What the poller needs from its host to publish a new-items page.
 *
 * Injected rather than imported so the core has no `child_process` or git
 * knowledge: the laptop script owns committing and dispatching, exactly as
 * `push-shengsiong.ts` does for the Sheng Siong file.
 */
export interface Publisher {
	/** Commit + push the results file and ask the cloud to rebuild the site. */
	publish(results: NewItemResult[]): Promise<void>;
}

export interface InboxDeps {
	notion: Client;
	publisher?: Publisher;
	/** Overridable for testing; defaults to the live shop scan. */
	scan?: (items: ParsedItem[]) => Promise<NewItemResult[]>;
	/**
	 * Set by any process that **cannot reach the shops** — which in practice means
	 * the cloud, because Sheng Siong challenges datacenter IPs and answers a
	 * residential one.
	 *
	 * ⚠️ **It leaves new items ON the queue instead of pricing them.** The tempting
	 * alternative — scan anyway, FairPrice-only — produces a new-items page that
	 * silently compares one shop and looks exactly like one that compared five. The
	 * residential runner drains the queue on its next wake (`tg-drain.ts`), so the
	 * answer is late rather than wrong. Everything else the inbox does (parsing,
	 * matching, writing the grocery-list row, asking questions) needs nothing but
	 * Notion and runs in the cloud at full speed.
	 */
	deferPricing?: boolean;
}

/**
 * The Ingredients DB, cached for a minute.
 *
 * Re-read rather than held for the process lifetime because the user may add a
 * row in Notion and immediately text the thing they just added — a poller that
 * cached at startup would keep calling it new for as long as the laptop stayed
 * awake. A minute is short enough that that never happens and long enough that a
 * six-line list is one query rather than six.
 */
let rowCache: { at: number; rows: IngredientRow[] } | null = null;
const ROW_TTL_MS = 60_000;

async function rows(deps: InboxDeps): Promise<IngredientRow[]> {
	if (rowCache && Date.now() - rowCache.at < ROW_TTL_MS) return rowCache.rows;
	const fresh = await readIngredientRows(deps.notion);
	rowCache = { at: Date.now(), rows: fresh };
	return fresh;
}

/** Write one matched (or unmatched-but-confirmed) item to the grocery List. */
async function writeItem(
	deps: InboxDeps,
	item: ParsedItem,
	row: IngredientRow | null,
): Promise<string> {
	const res = await addTextedItem(deps.notion, {
		// The MATCHED row's name when there is one: the list should read in the
		// user's own naming standard, not in whatever they thumbed into the phone.
		ingredient: row?.name ?? item.name,
		ingredientId: row?.pageId,
		count: item.count,
		size: sizeLabel(item),
		priceSgd: row?.price?.sgd,
		vendor: row?.price?.vendor,
		pricePerKg: row ? pricePerKgLabelFor(row) : undefined,
	});
	const price = row?.price ? `$${row.price.sgd.toFixed(2)} ${row.price.vendor}` : undefined;
	const line = wroteLine(res.title, item.count, price);
	return res.alreadyListed ? `${line} <i>(now ${res.amount})</i>` : line;
}

/**
 * Scan the queued new items, publish, and report. Called once the batch has no
 * unanswered questions left — so an item the user just told us was NOT a match
 * gets scanned along with the rest rather than in a second, separate page.
 */
async function drainQueue(deps: InboxDeps, state: InboxState): Promise<void> {
	const queue = state.queue;
	state.queue = [];
	if (!queue.length) return;

	const names = queue.map((i) => i.name);
	await sendHtml(`🔎 Pricing ${queue.length} new item${queue.length === 1 ? "" : "s"}: ${esc(names.join(", "))}…`);

	const scan = deps.scan ?? scanNewItems;
	let results: NewItemResult[];
	try {
		results = await scan(queue);
	} catch (e: any) {
		await sendHtml(`⚠️ Couldn't price the new items: ${esc(e.message)}`);
		return;
	}

	// A short summary in the chat AND the page: the summary answers "did it find
	// anything" without leaving Telegram, which for one or two items is the whole
	// question. The page is where the comparison is readable.
	const lines = results.map((r) => {
		if (!r.offers.length) return `• ${esc(r.query)} — not found`;
		const best = r.offers[0];
		const per = best.pricePer100g
			? ` ($${(best.pricePer100g * 10).toFixed(2)}/${best.volumetric ? "L" : "kg"})`
			: "";
		return `• ${esc(r.query)} — <b>$${best.priceSgd.toFixed(2)}</b>${per} at ${esc(best.store)}`;
	});
	await sendHtml(lines.join("\n"));

	if (!deps.publisher) return;
	try {
		await deps.publisher.publish(results);
		await sendHtml(`📄 <a href="${config.siteUrl()}new-items.html">New items page →</a>`);
	} catch (e: any) {
		await sendHtml(`⚠️ Priced them, but couldn't publish the page: ${esc(e.message)}`);
	}
}

/** Handle one text message. */
async function handleMessage(
	deps: InboxDeps,
	state: InboxState,
	text: string,
	chatId: number,
): Promise<void> {
	const trimmed = text.trim();
	if (/^\/(start|help)\b/i.test(trimmed)) {
		await sendHtml(HELP);
		return;
	}

	const items = parseList(trimmed);
	if (!items.length) {
		await sendHtml("I couldn't read any items in that. Send /help for the format.");
		return;
	}

	let known: IngredientRow[];
	try {
		known = await rows(deps);
	} catch (e: any) {
		await sendHtml(`⚠️ Couldn't read your Ingredients DB: ${esc(e.message)}`);
		return;
	}

	const decisions = decideList(items, known);
	const written: string[] = [];
	const failed: string[] = [];

	for (const d of decisions) {
		if (d.verdict === "linked" && d.match) {
			try {
				written.push(await writeItem(deps, d.item, d.match.row));
			} catch (e: any) {
				failed.push(`❌ ${esc(d.item.name)} — ${esc(e.message)}`);
			}
		} else if (d.verdict === "new") {
			state.queue.push(d.item);
		}
	}

	const reply = [...written, ...failed];
	if (reply.length) await sendHtml(reply.join("\n"));

	// Ask one message at a time, so each answer is unambiguous — a single message
	// with six sets of buttons is a mis-tap waiting to happen, and a mis-tap here
	// points a relation at the wrong row and quotes that row's price.
	for (const d of decisions) {
		if (d.verdict === "ask" && d.candidates.length) {
			await ask(state, d.item, chatId, toCandidates(d.candidates), { blocking: true });
		} else if (d.verdict === "new") {
			// An item nothing matched is queued for pricing AND offered a home. Until
			// 2026-08-11 it was only queued, so texting something you don't stock got
			// you a comparison on a web page and nothing on the list you shop from —
			// see fault 30.
			await ask(state, d.item, chatId, [], { blocking: false });
		}
	}

	await maybeDrain(deps, state);
}

/** `RowMatch`es as the keyboard stores them. */
function toCandidates(matches: RowMatch[]): AskCandidate[] {
	return matches.map((m) => ({
		rowId: m.row.pageId,
		rowName: m.row.name,
		score: m.score,
		parked: m.row.parked || undefined,
	}));
}

/**
 * The keyboard for one question: a button per candidate row, then the two ways
 * out.
 *
 * ⚠️ **One candidate per ROW of the keyboard, never two side by side.** These
 * labels are ingredient names — `Chicken thigh, Boneless [Seara]` beside
 * `chicken soup cube` — and Telegram shrinks the text to fit, so a two-column
 * layout is two truncated names on a phone and a coin flip between two different
 * foods.
 */
export function askKeyboard(t: string, candidates: AskCandidate[]): InlineKeyboard {
	const keyboard: InlineKeyboard = candidates.map((c, i) => [
		// 💤 marks a row you parked. It is on the button rather than in the message
		// because that is where the decision is made — picking it un-parks the row.
		{ text: `${c.parked ? "💤 " : ""}${c.rowName} · ${Math.round(c.score * 100)}%`, data: `p:${t}:${i}` },
	]);
	// ⚠️ **No "re-search" button** (removed 2026-08-11, by request: redundant). It
	// offered the NEXT tranche of rows from the Ingredients DB, and the user's read
	// is that the question already puts the options that matter in front of them —
	// so a second tranche was a tap that returned worse answers than the first.
	// What it cost: the rows above are the leader plus anything within
	// `CANDIDATE_MARGIN` of it (at most `MAX_CANDIDATES`), so a right-but-faint row
	// is no longer reachable from the keyboard. The way to that item is now the
	// same as for anything unrecognised — create it, or fix the row's name.
	keyboard.push([{ text: "🆕 New item — create in Ingredients", data: `c:${t}` }]);
	// ⚠️ **Always last, and always present.** This is the typo escape (asked for by
	// the user, 2026-08-11): a mistyped line should cost one tap to forget, not a
	// trip to Notion to delete a row and a page to un-publish. Its position matters
	// as much as its existence — the destructive-looking button sits furthest from
	// the candidates, so a fat thumb aiming at the last ingredient cannot reach it.
	keyboard.push([{ text: "✖️ Cancel — typo", data: `d:${t}` }]);
	return keyboard;
}

/** The question above the keyboard. */
function askText(item: ParsedItem, candidates: AskCandidate[]): string {
	return candidates.length
		? `❓ <b>${esc(item.name)}</b> — which of these did you mean?`
		: `🆕 <b>${esc(item.name)}</b> — nothing in your Ingredients looks like this.` +
				` I'll price it at the shops either way.`;
}

/** Send one question and record it as pending. */
async function ask(
	state: InboxState,
	item: ParsedItem,
	chatId: number,
	candidates: AskCandidate[],
	opts: { blocking: boolean },
): Promise<void> {
	const t = token(state.pending);
	const messageId = await sendHtml(askText(item, candidates), { keyboard: askKeyboard(t, candidates) });
	state.pending[t] = {
		item,
		candidates,
		messageId,
		chatId,
		blocking: opts.blocking,
		// Stamped at SEND time, not at parse time: the hour the user gets is an hour
		// of the question being on their screen.
		askedAt: new Date().toISOString(),
	};
}

/**
 * How long a question waits for a tap before the item is filed anyway.
 *
 * ⚠️ **An unanswered question used to mean an item that never arrived.** Asked for
 * by the user on 2026-08-12: a near-miss they never got round to tapping left the
 * line nowhere — not on the grocery list, not in Ingredients, just a message on a
 * phone. Shopping happens whether or not the question got answered, so the default
 * after an hour is to file the item rather than to keep waiting.
 */
export const ASK_TTL_MS = 60 * 60_000;

/** What one pass of the clock finds. Separated from the writing so it can be tested. */
export interface SweepPlan {
	/** Tokens whose hour is up — file these. */
	expired: string[];
	/** Tokens with no readable `askedAt`, whose clock starts now. */
	unstamped: string[];
}

/**
 * Which questions have run out of time, as of `now`. **Pure.**
 *
 * ⚠️ **A missing or unreadable `askedAt` starts the clock; it does not fire it.**
 * An ask carrying no timestamp is one of unknown age, and the two ways to read that
 * are not symmetric: treating it as old writes a Notion row for a question the user
 * may have been looking at for ten seconds, while treating it as new costs at most
 * one extra hour on a file that predates the feature. In practice the live state
 * file had no open asks when this shipped, so this path is a guard rather than a
 * migration.
 */
export function expiredAsks(pending: Record<string, PendingAsk>, now: number): SweepPlan {
	const plan: SweepPlan = { expired: [], unstamped: [] };
	for (const [t, ask] of Object.entries(pending)) {
		const at = Date.parse(ask.askedAt ?? "");
		if (!Number.isFinite(at)) plan.unstamped.push(t);
		else if (now - at >= ASK_TTL_MS) plan.expired.push(t);
	}
	return plan;
}

/** The outcome of a sweep, for the caller that has to decide whether to save. */
export interface SweepResult {
	/** Tokens filed and settled. */
	filed: string[];
	/** How many asks had their clock started. */
	stamped: number;
}

/**
 * File every question whose hour is up, and settle it in the chat.
 *
 * ```
 *   asked 14:02  ─── no tap ───▶  15:02  ─▶  grocery List row, Name only
 *                                            buttons replaced with the outcome
 * ```
 *
 * ⚠️ **The row is written with `row = null`, and that is the whole feature.** The
 * name goes in the title exactly as it was texted, and NOTHING is created in or
 * linked to the Ingredients DB — no relation, no price, no vendor, no `{New}` row.
 * The user was explicit (2026-08-12): *"just copy the name from the telegram chat
 * into 'Name' without adding an item into 'Ingredient' DB"*. That is deliberately
 * weaker than every other path here — an unlinked row carries no price and never
 * appears in the deal scan — because an unlinked row you can shop from beats a
 * question you never answered, and guessing which candidate they meant is the one
 * thing this must not do.
 *
 * ⚠️ **The queue is not touched.** A `blocking` near-miss was never queued, so
 * there is nothing to remove; a non-blocking "nothing looks like this" offer WAS
 * queued and stays queued, because the message it settles promised to price the
 * item at the shops either way.
 *
 * ⚠️ **A failed write still retires the question**, the same choice
 * `handleCallback` makes: a structural failure fails identically on the next sweep,
 * and re-trying every 15 minutes forever is a worse outcome than one ❌ in the chat.
 *
 * Never throws — every effect is individually wrapped, because a sweep runs on a
 * timer with nobody watching and must not take the poll loop down with it.
 */
export async function sweepExpiredAsks(
	deps: InboxDeps,
	state: InboxState,
	now = Date.now(),
): Promise<SweepResult> {
	const plan = expiredAsks(state.pending, now);
	const stamp = new Date(now).toISOString();
	for (const t of plan.unstamped) state.pending[t].askedAt = stamp;

	const filed: string[] = [];
	const lines: string[] = [];
	let queued = 0;

	for (const t of plan.expired) {
		const ask = state.pending[t];
		delete state.pending[t];
		filed.push(t);
		if (state.queue.some((q) => q.raw === ask.item.raw)) queued++;

		let outcome: string;
		try {
			outcome = await writeItem(deps, ask.item, null);
		} catch (e: any) {
			outcome = `❌ ${esc(ask.item.name)} — ${esc(e.message)}`;
		}
		lines.push(outcome);

		// The buttons must go, even if the summary below never sends: a live keyboard
		// on a settled question is a tap that writes the item a second time.
		try {
			await editHtml(ask.messageId, `⏳ No answer in an hour — filed as typed.\n${outcome}`, {
				chatId: String(ask.chatId),
			});
		} catch (e: any) {
			console.error(`expiry edit failed (cosmetic, carrying on): ${e?.message ?? e}`);
		}
	}

	if (lines.length) {
		// ⚠️ **A summary as well as the edits**, because an edit does not notify. The
		// user is by definition not watching — they left the question for an hour — and
		// a row appearing in Notion with no word in the chat is the silent-write failure
		// this project keeps re-learning.
		const head =
			lines.length === 1
				? "⏳ A question went an hour without an answer, so I filed it as typed:"
				: `⏳ ${lines.length} questions went an hour without an answer, so I filed them as typed:`;
		const tail =
			`<i>Name only — no Ingredients link and no price, and nothing was added to your ` +
			`Ingredients DB. Link ${lines.length === 1 ? "it" : "them"} in Notion if you want ` +
			`${lines.length === 1 ? "its" : "their"} price tracked.</i>` +
			(queued ? `\n<i>${queued === lines.length ? "Still" : `${queued} still`} queued for a shop price.</i>` : "");
		try {
			await sendHtml([head, ...lines, tail].join("\n"));
		} catch (e: any) {
			console.error(`expiry summary failed: ${e?.message ?? e}`);
		}
	}

	return { filed, stamped: plan.unstamped.length };
}

/**
 * Price the queue once nothing is left that could change what is in it.
 *
 * ⚠️ Gated on **blocking** questions, not on `pending` being empty. A new item's
 * "shall I file this?" offer stays live for as long as the user leaves it, and
 * waiting for that would mean a batch containing one unfamiliar item never gets
 * priced at all.
 */
export async function maybeDrain(deps: InboxDeps, state: InboxState): Promise<void> {
	// The cloud can't ask Sheng Siong anything. The queue stays put and the caller
	// says so in the chat — see `deferPricing`.
	if (deps.deferPricing) return;
	if (Object.values(state.pending).some((a) => a.blocking)) return;
	await drainQueue(deps, state);
}

/**
 * Stop Telegram's button spinner. **Cosmetic, and it may never gate the work.**
 *
 * ⚠️ **This is fault 29, seen live on 2026-08-10:**
 *
 * ```
 * update 523965592 failed: answerCallbackQuery HTTP 400:
 *   "Bad Request: query is too old and response timeout expired…"
 * ```
 *
 * The user tapped a button while no poller was running. By the time one started,
 * Telegram had expired the query id; the `await` threw, `handleCallback` aborted
 * **before** the Notion write, and `pumpOnce` advanced the offset anyway — so the
 * answer was consumed and lost, and the chat showed a question that had been
 * answered and a row that never appeared. A spinner nobody is watching any more is
 * worth nothing; the write is worth everything. Failing here is now a logged
 * shrug.
 */
async function ack(id: string, text?: string): Promise<void> {
	try {
		await answerCallback(id, text);
	} catch (e: any) {
		// Expected whenever the tap is older than Telegram's callback window.
		console.error(`answerCallback failed (cosmetic, carrying on): ${e?.message ?? e}`);
	}
}

/**
 * Answer one price-book review card: **OK** records the pick, **Don't use** refuses it.
 *
 * ⚠️ **"Don't use" does NOT touch `exclusions.json`, and that is the point of the whole
 * feature.** The user was explicit (2026-08-11): *"just because it is 'Don't use' does
 * not mean it should not show up in Discount page. (if i don't want it there either, it
 * will be put into the 'ignore forever' option.)"* So a refusal here is scoped to one
 * ingredient at one shop in the price book, and the deals page goes on offering the
 * product exactly as before. The button that removes something from the deals page is
 * the red **Ignore** on the page itself, which writes `ALL_ITEMS` — a different store,
 * a different meaning, deliberately not reachable from here.
 *
 * A refusal is remembered so the next scan offers the NEXT-best pack instead of asking
 * the same question again (`isRejectedPick` is applied before the pick, not after).
 */
async function handleReviewCallback(
	deps: InboxDeps,
	cb: NonNullable<TgUpdate["callback_query"]>,
	token: string,
	accept: boolean,
): Promise<void> {
	const file = await readVendorReview();
	const p = (file.pending ?? []).find((x) => x.token === token);
	if (!p) {
		await ack(cb.id, "That question has already been answered.");
		return;
	}
	await ack(cb.id);

	const chatId = String(cb.message?.chat.id ?? p.chatId ?? "");
	const messageId = cb.message?.message_id ?? p.messageId;
	const settle = async (text: string) => {
		if (messageId) {
			try {
				await editHtml(messageId, text, { chatId });
			} catch (e: any) {
				console.error(`review edit failed (cosmetic, carrying on): ${e?.message ?? e}`);
			}
		}
	};

	if (!accept) {
		const { file: next } = withRejectedPick(withoutPending(file, token), {
			ingredientId: p.ingredientId,
			vendor: p.vendor,
			url: p.url,
			store: p.vendor,
			product: p.itemName,
			name: p.ingredientName,
			why: p.reasons.map((r) => r.note).join("; "),
		});
		await writeVendorReview(next);
		await settle(
			`✖️ <b>${esc(p.ingredientName)}</b> — not recorded at ${esc(p.vendor)}.\n` +
				`<i>${esc(p.itemName)}</i>\n` +
				`I won't offer this pack for this row again. It still shows on your deals page.`,
		);
		return;
	}

	let outcome: string;
	try {
		const res = await recordVendorPrice(deps.notion, p.ingredientId, {
			vendor: p.vendor,
			priceSgd: p.priceSgd,
			size: p.size,
			url: p.url,
			itemName: p.itemName,
		});
		// ⚠️ The test is the SLOT decision, never "were any properties sent" — a button
		// that reports a write it did not make is worse than one that fails loudly
		// (live bug, 2026-08-09).
		outcome =
			res.slot != null && res.slot.kind !== "none"
				? `✅ <b>${esc(p.ingredientName)}</b> — recorded at ${esc(p.vendor)}.\n` +
					`<i>${esc(p.itemName)}</i>\n$${p.priceSgd.toFixed(2)}${p.perLabel ? ` · ${esc(p.perLabel)}` : ""}`
				: `⚠️ <b>${esc(p.ingredientName)}</b> — not written: ${esc(describeSlotDecision(res.slot))}`;
	} catch (e: any) {
		outcome = `❌ <b>${esc(p.ingredientName)}</b> — ${esc(e.message)}`;
	}
	// Taken off the queue either way: a write that failed for a structural reason (the
	// slot was retagged, the row was deleted) will fail identically on a second tap, and
	// the next scan re-queues anything still genuinely uncertain.
	await writeVendorReview(withoutPending(file, token));
	await settle(outcome);
}

/** Handle one button tap. */
async function handleCallback(
	deps: InboxDeps,
	state: InboxState,
	cb: NonNullable<TgUpdate["callback_query"]>,
): Promise<void> {
	const [verb, t, arg] = (cb.data ?? "").split(":");

	// ⚠️ Price-book review taps are answered from their OWN store, not from the inbox
	// state file: they are queued by `vendor-scan` (a separate process, possibly days
	// earlier) and must survive a poller restart. Handled before the inbox lookup below,
	// which would otherwise reject the token as an already-answered question.
	if (verb === "vy" || verb === "vn") {
		await handleReviewCallback(deps, cb, t, verb === "vy");
		return;
	}

	const pending = t ? state.pending[t] : undefined;

	// Acknowledge first, always. Telegram spins the button until this lands, so a
	// stale token must still clear the spinner rather than leaving it turning.
	if (!pending) {
		await ack(cb.id, "That question has already been answered.");
		return;
	}
	await ack(cb.id);

	const edit = (text: string, keyboard?: InlineKeyboard) =>
		editHtml(pending.messageId, text, { chatId: String(pending.chatId), keyboard });
	/** Settle the question: its buttons become its outcome and cannot be tapped again. */
	const settle = async (text: string) => {
		delete state.pending[t];
		await edit(text);
	};

	switch (verb) {
		case "p": {
			// One of the offered rows. This is also the answer to "which one" — the
			// tie that fault 28 used to resolve by whichever row Notion listed first.
			const chosen = pending.candidates[Number(arg)];
			if (!chosen) {
				await settle(`⚠️ ${esc(pending.item.name)} — that option is no longer available.`);
				break;
			}
			// An item ruled `new` was queued for pricing when it arrived; linking it to
			// a row it turns out we already have means it must come back out, or it is
			// priced as a new item on a page while sitting on the list as a known one.
			state.queue = state.queue.filter((q) => q.raw !== pending.item.raw);
			let outcome: string;
			try {
				// Re-looked-up rather than taken from the pending record: a question can
				// sit unanswered for hours, and the price quoted on the list should be
				// the one on the row now. A row deleted in the meantime falls back to the
				// name we asked about, so the item still lands on the list.
				const row = (await rows(deps)).find((r) => r.pageId === chosen.rowId) ?? {
					pageId: chosen.rowId,
					name: chosen.rowName,
					searchTerm: chosen.rowName,
					unitType: "By Gram" as const,
					parked: false,
					price: null,
				};
				outcome = await writeItem(deps, pending.item, row);
				outcome += await unparkIfNeeded(deps, row);
			} catch (e: any) {
				outcome = `❌ ${esc(pending.item.name)} — ${esc(e.message)}`;
			}
			await settle(outcome);
			break;
		}

		case "r":
			// A re-search button from a keyboard sent BEFORE it was removed
			// (2026-08-11). Kept only to re-draw the question — falling through to
			// `default` would settle it, and so throw away an item the user has not
			// actually answered, on a tap that used to be harmless. Delete this once
			// no question predating the change can still be open.
			await edit(askText(pending.item, pending.candidates), askKeyboard(t, pending.candidates));
			break;

		case "c": {
			// Creating a row is the one action here with no undo, in a live personal
			// workspace, so it shows exactly what it is about to write and asks again —
			// the same courtesy *Not in use* and *Replace* extend on the deals page.
			const fields = newIngredientFields(pending.item);
			pending.awaitingCreate = true;
			await edit(
				`➕ Create <b>${esc(fields.name)}</b> in Ingredients?\n` +
					// The category shown is this project's own key. The Notion OPTION is
					// resolved from the live list at write time and dropped if it isn't
					// there — this tool never invents schema — so the row can legitimately
					// land uncategorised even though a guess is quoted here.
					`<i>${esc(fields.categoryKey ?? "uncategorised")} · ${esc(fields.unitType ?? "—")}</i>\n` +
					`It'll go on your grocery list too. No price yet — the shop scan fills that in.`,
				[
					[{ text: "✅ Yes, create it", data: `k:${t}` }],
					[{ text: "✖ Cancel", data: `x:${t}` }],
				],
			);
			break;
		}

		case "k": {
			if (!pending.awaitingCreate) break; // a stale confirm button; ignore quietly
			let outcome: string;
			try {
				outcome = await createAndList(deps, pending.item);
			} catch (e: any) {
				outcome = `❌ ${esc(pending.item.name)} — ${esc(e.message)}`;
			}
			await settle(outcome);
			break;
		}

		case "x":
			// Backing out of the create CONFIRM, not out of the item. It returns to
			// the question rather than settling it: "no, I didn't mean create" is not
			// the same statement as "forget this line", and there is now a Cancel
			// button that means the second one.
			pending.awaitingCreate = false;
			await edit(askText(pending.item, pending.candidates), askKeyboard(t, pending.candidates));
			break;

		case "d":
			// The typo escape. Nothing has been written for this item — a near-miss is
			// only ever written once answered — so dropping it really is a no-op, and
			// the only thing to undo is its place in the pricing queue.
			state.queue = state.queue.filter((q) => q.raw !== pending.item.raw);
			await settle(`✖️ ${esc(pending.item.raw)} — dropped. Nothing written.`);
			break;

		default:
			await settle(`⚠️ ${esc(pending.item.name)} — I didn't understand that button.`);
	}

	await maybeDrain(deps, state);
}

/**
 * Wake a parked row that the user has just picked, and say so.
 *
 * ⚠️ **Buying something is the un-park.** `Not in Use ATM` means "don't show me
 * this for now", and putting the item on your list is the plainest possible
 * statement that "for now" is over — leaving the tag on would keep the ingredient
 * out of the daily deal scan for a thing sitting on the shopping list.
 *
 * ⚠️ It is only ever reached from an explicit tap, never from a silent link —
 * `decideItem` refuses to link a parked row however well it scores, precisely so
 * this write cannot happen by accident.
 *
 * ⚠️ `unparkIngredient` removes **only** that one tag and refuses outright on a
 * row that also carries `Don't Search`. Failing to wake a row must not lose the
 * list line that was already written, so a failure here is reported, not thrown.
 */
async function unparkIfNeeded(deps: InboxDeps, row: IngredientRow): Promise<string> {
	if (!row.parked) return "";
	try {
		const res = await unparkIngredient(deps.notion, row.pageId);
		rowCache = null; // the row's tags changed; don't answer from a stale copy
		if (res.blockedBy) return `\n<i>Left parked — it also carries ${esc(res.blockedBy)}.</i>`;
		return `\n<i>💤 → awake: removed ${esc(PARKED_TAG)}.</i>`;
	} catch (e: any) {
		return `\n<i>⚠️ Couldn't un-park it: ${esc(e.message)}</i>`;
	}
}

/**
 * What a texted item becomes as an Ingredients row.
 *
 * ⚠️ **The marker is `{New}`, in BRACES, and the brackets are not
 * interchangeable** (the user chose this on 2026-08-11 from three options).
 * `parseName` reads `( )` as a **defining property** — a hard requirement on the
 * product title — so a row called `(New) Harissa Paste` would demand the word
 * "new" from every candidate at every shop, match nothing, and appear in no
 * section of the deals page, all while looking perfectly ordinary in Notion.
 * `{ }` is the ignored bracket: excluded from the search term and from every
 * matching decision, which is exactly this job. It marks the row as unreviewed to
 * a human and is invisible to the scan.
 *
 * No price and no size are written. Both belong to a vendor slot, and a slot
 * holding a size with no price and no shop is not a price book entry — it is a
 * half-fact that `readBaseline` would have to step over. The shop scan fills
 * them in properly.
 */
export function newIngredientFields(item: ParsedItem): IngredientFields {
	const key = categorize(item.name);
	return {
		name: `{New} ${item.name.trim()}`,
		categoryKey: key,
		unitType: unitTypeFor(item),
	};
}

/**
 * `Unit type ` from what the user actually typed — the same inference
 * `fieldsFromPurchase` makes from a pack: a stated volume is `By ml`, a stated
 * weight is `By Gram`, and a bare count is `By Unit`.
 *
 * An item with no quantity at all ("harissa paste") gets `By Gram`, the type most
 * groceries have. ⚠️ Getting this wrong is not silent — it is visible on the row
 * and one dropdown to correct — which is why it guesses rather than asking.
 */
export function unitTypeFor(item: ParsedItem): string {
	if (item.amountG != null) return item.volumetric ? "By ml" : "By Gram";
	return item.count > 1 ? "By Unit" : "By Gram";
}

/**
 * Create the Ingredients row, then put the item on the grocery list against it.
 *
 * The second half is the point of the whole button: fault 30 was that a new item
 * got a price comparison on a web page and never reached the list you shop from.
 */
async function createAndList(deps: InboxDeps, item: ParsedItem): Promise<string> {
	const fields = newIngredientFields(item);
	const res = await createIngredient(deps.notion, fields);
	// The cache would otherwise keep calling this row new for up to a minute — and
	// the same list, re-sent, would offer to create it a second time.
	rowCache = null;
	const row: IngredientRow = {
		pageId: res.id,
		name: fields.name,
		searchTerm: item.name,
		unitType: fields.unitType as IngredientRow["unitType"],
		parked: false,
		price: null,
	};
	const listed = await writeItem(deps, item, row);
	const skipped = res.skipped.length ? `\n<i>Not written: ${esc(res.skipped.join("; "))}</i>` : "";
	return `➕ Created <b>${esc(row.name)}</b> in Ingredients\n${listed}${skipped}`;
}

/**
 * Drain whatever Telegram has, handling each update and persisting after each.
 * Returns how many updates were processed.
 */
export async function pumpOnce(
	deps: InboxDeps,
	state: InboxState,
	timeoutSec = 25,
): Promise<number> {
	const updates = await getUpdates(state.offset, timeoutSec);
	for (const u of updates) {
		await handleUpdate(deps, state, u);
		// After handling, never before: an offset advanced early loses the message.
		//
		// ⚠️ **It advances even when the handler threw, and that is deliberate.**
		// The alternative — retry until it succeeds — turns one poison update into
		// an infinite loop that blocks every message behind it, which is a worse
		// failure than losing one line of a shopping list. The user is told instead,
		// in `handleUpdate`, and can send it again.
		state.offset = u.update_id + 1;
		await writeState(state);
	}
	return updates.length;
}

/**
 * Handle exactly one update, however it arrived. **Never throws.**
 *
 * Both doors into the inbox come through here — the laptop's long poll
 * (`pumpOnce`) and the cloud's webhook (`tg-handle.ts`, one update per Actions
 * run) — so the chat allow-list, the drop-report and the choice of what counts as
 * an update at all are decided in exactly one place. When these were inline in the
 * poll loop, the webhook path would have had to restate all three and could have
 * restated any of them slightly differently; the allow-list is not a check worth
 * having two copies of.
 */
export async function handleUpdate(
	deps: InboxDeps,
	state: InboxState,
	u: TgUpdate,
): Promise<void> {
	const allowed = String(config.telegramChatId());
	try {
		if (u.message?.text && String(u.message.chat.id) === allowed) {
			await handleMessage(deps, state, u.message.text, u.message.chat.id);
		} else if (u.callback_query && String(u.callback_query.message?.chat.id) === allowed) {
			await handleCallback(deps, state, u.callback_query);
		}
		// Anything else — another chat, a photo, a sticker — is dropped in silence.
	} catch (e: any) {
		console.error(`update ${u.update_id} failed: ${e?.stack ?? e}`);
		// ⚠️ **Say so in the chat.** This update is gone either way — the poller has
		// already advanced its offset and the webhook has already been answered 200 —
		// and the whole point of fault 29 was that a swallowed update looks exactly
		// like a handled one from the sofa. One line to a console nobody is watching
		// is not a report. Wrapped because the thing that just failed may well be
		// Telegram itself.
		try {
			await sendHtml(`⚠️ I dropped that one — ${esc(e?.message ?? String(e))}. Please send it again.`);
		} catch {
			/* the chat is unreachable too; the console line is all there is */
		}
	}
}

/** Long-poll forever (or once, for a scheduled short-lived run). */
export async function runInbox(deps: InboxDeps, opts: { once?: boolean } = {}): Promise<void> {
	const state = await readState();
	do {
		try {
			await pumpOnce(deps, state);
			// ⚠️ **The one-hour clock, checked here rather than on a timer.** The long
			// poll returns at least every 25 s whether or not anything arrived, so this
			// loop is already the most accurate clock the poller has, and a `setInterval`
			// alongside it would mutate the same state object from two places. Filing an
			// item can also unblock the pricing queue, hence the `maybeDrain`.
			const swept = await sweepExpiredAsks(deps, state);
			if (swept.filed.length) await maybeDrain(deps, state);
			if (swept.filed.length || swept.stamped) await writeState(state);
		} catch (e: any) {
			// A network blip must not kill a long-running poller. Back off and retry.
			console.error(`poll failed: ${e.message}`);
			if (opts.once) throw e;
			await new Promise((r) => setTimeout(r, 5000));
		}
	} while (!opts.once);
}
