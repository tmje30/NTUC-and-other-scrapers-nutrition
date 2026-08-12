/**
 * Does Sheng Siong answer a Cloudflare Worker?
 *
 * A throwaway probe, not part of the system. HANDOVER's 2026-08-11 experiment
 * established that the constraint is **which country the address is in** — a
 * Singapore datacenter address got 60 terms / 765 products with no cached
 * Incapsula cookie, while US addresses were challenged even after minting one.
 * That makes a Worker worth testing: if it egresses from Cloudflare's Singapore
 * colo, it may be treated exactly like the laptop.
 *
 * ⚠️ **A pass here does NOT mean the laptop can be retired.** Workers run in the
 * colo nearest the *incoming request*, so this proves only the case where the
 * request comes from Singapore — i.e. you, tapping. A cron trigger has no
 * incoming request and can run anywhere on the network, and Durable Object
 * location hints are region-coarse (`apac` covers Tokyo, Sydney, Hong Kong and
 * Seoul as readily as Singapore). Read `colo` in the output before believing
 * anything else in it.
 *
 * Deploy from this directory, hit the URL once, read the JSON, then
 * `wrangler delete`. It holds no secrets and stores nothing.
 */

const WS_URL = "https://shengsiong.com.sg/websocket";
const PAGE_URL = "https://shengsiong.com.sg/";

/** Incapsula's challenge is a 200 with a JS puzzle in it, never an error status. */
function looksChallenged(status, body) {
	if (status === 403 || status === 503) return true;
	return /_Incapsula_Resource|incident_id|\/_Incapsula_/i.test(body);
}

async function withTimeout(promise, ms, label) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The plain front door: does the HTML page come back, or a challenge? */
async function probePage() {
	try {
		const res = await withTimeout(fetch(PAGE_URL, { headers: { "user-agent": "Mozilla/5.0" } }), 10_000, "page fetch");
		const body = (await res.text()).slice(0, 4000);
		return { status: res.status, challenged: looksChallenged(res.status, body), bytes: body.length };
	} catch (e) {
		return { error: String(e.message ?? e) };
	}
}

/**
 * The real test. The 2026-07-30 failure signature was every search dying at the
 * WebSocket upgrade with "Unexpected server response: 200" — a challenge served
 * where a 101 was expected. So the upgrade, plus one DDP `connect`, is what
 * actually distinguishes "we are in Singapore" from "we are not".
 */
async function probeDdp() {
	try {
		const res = await withTimeout(fetch(WS_URL, { headers: { Upgrade: "websocket" } }), 10_000, "ws upgrade");
		if (res.status !== 101 || !res.webSocket) {
			const body = (await res.text().catch(() => "")).slice(0, 2000);
			return { upgraded: false, status: res.status, challenged: looksChallenged(res.status, body) };
		}
		const ws = res.webSocket;
		ws.accept();
		const reply = await withTimeout(
			new Promise((resolve) => {
				ws.addEventListener("message", (ev) => resolve(String(ev.data).slice(0, 200)), { once: true });
				ws.send(JSON.stringify({ msg: "connect", version: "1", support: ["1"] }));
			}),
			8_000,
			"ddp connect",
		);
		ws.close();
		// Meteor answers `connect` with `connected` (or `failed` with a version to
		// retry on). Either proves we are talking to the app, not to the WAF.
		return { upgraded: true, status: 101, reply, spokeDdp: /"msg":"(connected|failed)"/.test(reply) };
	} catch (e) {
		return { error: String(e.message ?? e) };
	}
}

const MISC_FILTERS = {
	brands: { slugs: [] },
	prices: { slugs: [] },
	countryOfOrigins: { slugs: [] },
	dietaryHabits: { slugs: [] },
	tags: { slugs: [] },
	promotionTypes: { slugs: [] },
	sortBy: { slug: "" },
};

function filters(term) {
	return {
		categoryFilter: { slugs: [] },
		campaignPageFilter: { slug: "", category: { slug: "" } },
		shoppingListFilter: { slug: "", category: { slug: "" }, search: { slug: "" }, showKeptForLater: false },
		searchFilter: { slug: term, category: { slug: "" } },
		preOrderCampaignFilter: { slug: "", category: { slug: "" } },
		ecommPromotionFilter: { active: false, category: { slug: "" } },
	};
}

/** A stand-in for `parseWeight` — the per-product string work, so the CPU measured is honest. */
const WEIGHT = /(\d+(?:\.\d+)?)\s*(kg|g|gm|ml|l|ltr)\b/i;
function mapProduct(p) {
	const m = WEIGHT.exec(String(p.packSize ?? ""));
	let grams = null;
	if (m) {
		const n = Number(m[1]);
		const u = m[2].toLowerCase();
		grams = u === "kg" || u === "l" || u === "ltr" ? n * 1000 : n;
	}
	const price = Number(p.price);
	const prev = p.prevPrice ? Number(p.prevPrice) : 0;
	return {
		name: p.name,
		brand: p.brand,
		priceSgd: price,
		packWeightG: grams,
		pricePer100g: grams ? (price / grams) * 100 : null,
		onSale: prev > price,
		url: `https://shengsiong.com.sg/product/${p.slug}`,
	};
}

/**
 * The real thing: N searches down ONE WebSocket, parsed the way the runner parses
 * them. The question this answers is binary — does it finish, or does the Worker
 * get killed for exceeding its CPU allowance?
 */
async function runScan(limit) {
	const started = Date.now();
	const res = await fetch("https://tmje30.github.io/NTUC-and-other-scrapers-nutrition/targets.json", {
		headers: { "cache-control": "no-cache" },
	});
	const data = await res.json();
	const all = (Array.isArray(data) ? data : data.terms).map(String);
	const terms = all.slice(0, limit);

	const up = await fetch(WS_URL, { headers: { Upgrade: "websocket" } });
	if (up.status !== 101 || !up.webSocket) return { error: `upgrade failed: ${up.status}` };
	const ws = up.webSocket;
	ws.accept();

	const pending = new Map();
	let connected;
	const connectedP = new Promise((r) => (connected = r));
	ws.addEventListener("message", (ev) => {
		const d = JSON.parse(String(ev.data));
		if (d.msg === "connected") connected();
		else if (d.msg === "ping") ws.send(JSON.stringify({ msg: "pong", id: d.id }));
		else if (d.msg === "result" && pending.has(d.id)) {
			pending.get(d.id)(d);
			pending.delete(d.id);
		}
	});
	ws.send(JSON.stringify({ msg: "connect", version: "1", support: ["1"] }));
	await withTimeout(connectedP, 10_000, "ddp connect");

	let id = 0;
	let products = 0;
	let errors = 0;
	const perTerm = [];
	for (const term of terms) {
		const myId = String(++id);
		try {
			const reply = await withTimeout(
				new Promise((resolve) => {
					pending.set(myId, resolve);
					ws.send(
						JSON.stringify({
							msg: "method",
							method: "Products.getByAllSlugs",
							params: [filters(term), MISC_FILTERS, 1, 50],
							id: myId,
						}),
					);
				}),
				20_000,
				`search "${term}"`,
			);
			const raw = reply.result;
			const list = Array.isArray(raw) ? raw : (raw?.products ?? raw?.items ?? []);
			const mapped = list.map(mapProduct);
			products += mapped.length;
			perTerm.push({ term, n: mapped.length });
		} catch (e) {
			errors++;
			perTerm.push({ term, error: String(e.message ?? e) });
		}
		await new Promise((r) => setTimeout(r, 400)); // the runner's politeness pause
	}
	ws.close();

	return {
		terms: terms.length,
		products,
		errors,
		// ⚠️ Wall clock, NOT CPU. Workers freeze the clock except across I/O, so this
		// cannot be turned into a CPU figure — it is here only to show the scan ran at
		// a realistic pace. The CPU verdict is whether this response exists at all.
		wallMs: Date.now() - started,
		sample: perTerm.slice(0, 8),
	};
}

export default {
	async fetch(request) {
		// `?scan=50` runs the real workload; without it, the cheap reachability probe.
		const limit = Number(new URL(request.url).searchParams.get("scan") || 0);
		if (limit > 0) {
			const colo = request.cf?.colo ?? "unknown";
			try {
				return Response.json({ mode: "scan", colo, ...(await runScan(limit)) }, { headers: { "cache-control": "no-store" } });
			} catch (e) {
				return Response.json({ mode: "scan", colo, error: String(e.message ?? e) }, { status: 500 });
			}
		}
		// Where this Worker is actually running. The single most important field:
		// "SIN" is the only value that makes the rest of the result meaningful.
		const colo = request.cf?.colo ?? "unknown";
		let trace = null;
		try {
			const res = await withTimeout(fetch("https://cloudflare.com/cdn-cgi/trace"), 8_000, "trace");
			trace = Object.fromEntries(
				(await res.text())
					.trim()
					.split("\n")
					.map((line) => line.split("="))
					.filter(([k]) => ["ip", "loc", "colo"].includes(k)),
			);
		} catch (e) {
			trace = { error: String(e.message ?? e) };
		}

		const [page, ddp] = await Promise.all([probePage(), probeDdp()]);
		const verdict = ddp.spokeDdp
			? "PASS — Sheng Siong spoke DDP to this Worker"
			: ddp.upgraded === false || ddp.error
				? "FAIL — the WebSocket upgrade did not reach the app"
				: "INCONCLUSIVE — read the fields";

		return Response.json(
			{ verdict, colo, trace, page, ddp, note: "colo must be SIN for a pass to mean anything" },
			{ headers: { "cache-control": "no-store" } },
		);
	},
};
