/**
 * Probe every vendor in the Website Used DB for one search term, and say what works.
 *
 *   npm run vendor-probe -- "whey protein"
 *   npm run vendor-probe -- "whey protein" --only carousell,iherb
 *   npm run vendor-probe -- "vitamin d" --browser          # include the browser tier
 *   npm run vendor-probe -- "whey protein" --browser --headed --login shopee
 *
 * Writes NOTHING — not to Notion, not to the repo. It answers one question per vendor:
 * *could a scraper get a price and a pack size out of this shop today, and if not, why not?*
 * The "why not" is the point: a 403 from Akamai, an SPA shell and an auth redirect all look
 * like "no results" from the outside and need completely different fixes.
 *
 * Tiers, cheapest first — the same ladder the sibling Inventory Price Upkeeper project uses:
 *   1. `fetch`   — plain GET + parse. Free and fast.
 *   2. `browser` — real Chrome over CDP (`--browser`). For SPAs and soft bot-walls.
 *   3. `login`   — a browser on a PERSISTED profile (`--login <vendor>`), for auth walls.
 *
 * ⚠️ The login tier does NOT log in. It opens a headed window on a profile kept under
 * `.sessions/`; you sign in by hand ONCE and the session persists for later runs. Nothing
 * here types a credential — see the project rules.
 */

import { marketplaceSize, cheapestPlausible } from "../core/marketplace-size.js";
import { evaluateInPage } from "../core/browser-cdp.js";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const HEADERS: Record<string, string> = {
	"User-Agent": UA,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-SG,en;q=0.9",
	"Upgrade-Insecure-Requests": "1",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
};

interface Candidate {
	title: string;
	priceSgd: number;
	sizeText: string | null;
	grams: number | null;
	pricePer100g: number;
	url?: string;
}

interface ProbeResult {
	vendor: string;
	tier: "fetch" | "browser" | "login";
	reachable: boolean;
	/** HTTP status, or the redirect we were bounced to. */
	detail: string;
	candidates: Candidate[];
	/** What a developer should do next. The single most useful field here. */
	fix: string;
	verdict: "works" | "blocked" | "no-data" | "needs-login" | "error";
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function get(url: string, timeoutMs = 25_000): Promise<{ status: number; body: string; finalUrl: string; server: string }> {
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { headers: HEADERS, redirect: "follow", signal: ctl.signal });
		const body = await res.text();
		return { status: res.status, body, finalUrl: res.url, server: res.headers.get("server") ?? "" };
	} finally {
		clearTimeout(t);
	}
}

/** Price per 100 g, or null when either half is missing. Guards divide-by-zero. */
function per100(priceSgd: number, grams: number | null): number | null {
	if (!Number.isFinite(priceSgd) || priceSgd <= 0 || !grams || grams <= 0) return null;
	return (priceSgd / grams) * 100;
}

function candidateFrom(title: string, priceSgd: number, url?: string): Candidate | null {
	const size = marketplaceSize(title);
	const grams = size.ok ? size.grams : null;
	const p = per100(priceSgd, grams);
	if (p == null) return null;
	return { title, priceSgd, sizeText: size.ok ? size.basis : null, grams, pricePer100g: p, url };
}

/** Every `"key":"value"`-ish price in a blob, without trusting the whole JSON to parse. */
function looseMatches(body: string, re: RegExp, limit = 40): RegExpMatchArray[] {
	return [...body.matchAll(re)].slice(0, limit);
}

/**
 * Every JSON-LD `Product` node in a page, parsed properly rather than regexed.
 *
 * Written after the first probe run: a `"name" … "price"` regex found 0 of MyProtein's **28**
 * products, because the two keys are separated by `@id`, `url`, `sku` and a CDN image URL. The
 * shape is perfectly clean JSON — the regex was the only thing wrong. Walking the tree also
 * survives a shop reordering its keys, which a proximity regex never does.
 */
function jsonLdProducts(body: string): any[] {
	const out: any[] = [];
	for (const m of body.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
		let data: unknown;
		try {
			data = JSON.parse(m[1]);
		} catch {
			continue; // a broken block is not worth a repair ladder here — the probe just reports less
		}
		const walk = (n: any): void => {
			if (!n || typeof n !== "object") return;
			if (Array.isArray(n)) return n.forEach(walk);
			if (n["@type"] === "Product" || (Array.isArray(n["@type"]) && n["@type"].includes("Product"))) out.push(n);
			Object.values(n).forEach(walk);
		};
		walk(data);
	}
	return out;
}

function offerPrice(p: any): number | null {
	const o = Array.isArray(p?.offers) ? p.offers[0] : p?.offers;
	const v = Number(o?.price ?? o?.lowPrice);
	return Number.isFinite(v) && v > 0 ? v : null;
}

// ---------------------------------------------------------------------------
// per-vendor probes
// ---------------------------------------------------------------------------

async function probeIherb(term: string): Promise<ProbeResult> {
	const url = `https://sg.iherb.com/search?kw=${encodeURIComponent(term)}`;
	const r = await get(url);
	const base = { vendor: "Iherb", tier: "fetch" as const, reachable: r.status === 200, detail: `HTTP ${r.status}` };
	if (r.status !== 200) {
		return {
			...base,
			candidates: [],
			verdict: "blocked",
			fix: "iHerb bot-walled this request. The sibling project routes it through the real ordering Chrome (CDP_SHOPS) with the bot check cleared once. Re-run with --browser.",
		};
	}
	// The sibling project's SEARCH_OVERRIDES row: results are /pr/ links and the NAME lives in
	// the link's `title` attribute, not its text.
	const names = looseMatches(r.body, /<a[^>]+href="[^"]*\/pr\/[^"]*"[^>]*title="([^"]{4,160})"/gi);
	const prices = looseMatches(r.body, /itemprop="price"\s+content="([\d.]+)"/gi);
	const cands: Candidate[] = [];
	for (let i = 0; i < Math.min(names.length, prices.length); i++) {
		const c = candidateFrom(names[i][1], Number(prices[i][1]));
		if (c) cands.push(c);
	}
	return {
		...base,
		candidates: cands,
		verdict: cands.length ? "works" : names.length ? "no-data" : "no-data",
		fix: cands.length
			? "Works over plain fetch today. Keep CDP as a fallback rung — the block is intermittent, exactly like Sheng Siong's."
			: `Page fetched (${r.body.length}B) but ${names.length} titles / ${prices.length} prices parsed. Check the /pr/ link + title-attribute pattern still holds.`,
	};
}

async function probeMyProtein(term: string): Promise<ProbeResult> {
	const url = `https://www.myprotein.com.sg/search/?q=${encodeURIComponent(term)}`;
	const r = await get(url);
	const base = { vendor: "My Protein", tier: "fetch" as const, reachable: r.status === 200, detail: `HTTP ${r.status}` };
	if (r.status !== 200) {
		return { ...base, candidates: [], verdict: "blocked", fix: "Unexpected — MyProtein served a bare fetch on 2026-08-04. Check for a new WAF." };
	}
	const products = jsonLdProducts(r.body);
	const cands: Candidate[] = [];
	let priced = 0;
	let noSize = 0;
	for (const p of products) {
		const price = offerPrice(p);
		if (price == null) continue;
		priced++;
		const c = candidateFrom(String(p.name ?? ""), price, p.url ? `https://www.myprotein.com.sg${p.url}` : undefined);
		c ? cands.push(c) : noSize++;
	}
	return {
		...base,
		detail: `HTTP ${r.status}, ${products.length} JSON-LD products, ${priced} priced, ${cands.length} with a size`,
		candidates: cands,
		verdict: cands.length ? "works" : priced ? "no-data" : "no-data",
		fix: cands.length
			? "Server-rendered JSON-LD with name + offers.price. Cheapest adapter of the lot."
			: priced
				? `⚠️ Prices parse fine (${priced}) but ${noSize} titles carry NO pack size — MyProtein names products "Impact Whey Protein + Collagen" and keeps the size in the on-page variant selector. So this shop needs a SECOND fetch of the product page (or its variant JSON) to be comparable at all. That is the real work here, not the search.`
				: `Fetched ${r.body.length}B but no JSON-LD products — check the search URL still renders server-side.`,
	};
}

async function probeGuardian(term: string): Promise<ProbeResult> {
	const url = `https://www.guardian.com.sg/catalogsearch/result/?q=${encodeURIComponent(term)}`;
	const r = await get(url);
	const isShell = r.body.length > 100_000 && !/itemprop="price"|"price"\s*:/.test(r.body);
	return {
		vendor: "Guardian Pharmacy",
		tier: "fetch",
		reachable: r.status === 200,
		detail: `HTTP ${r.status}, ${r.body.length}B${r.server ? `, server=${r.server}` : ""}`,
		candidates: [],
		verdict: isShell ? "no-data" : r.status === 200 ? "no-data" : "blocked",
		fix: isShell
			? "SPA shell — every Guardian URL returns the same ~137KB page with no products. NO anti-bot (plain 200, Fastly cache). Fix is the BROWSER tier, not a WAF workaround: re-run with --browser. Its /graphql endpoint exists and is the cheaper long-term route."
			: "Unexpected shape — re-inspect.",
	};
}

async function probeWatsons(term: string): Promise<ProbeResult> {
	const url = `https://www.watsons.com.sg/search?text=${encodeURIComponent(term)}`;
	const r = await get(url).catch((e) => ({ status: 0, body: String(e), finalUrl: url, server: "" }));

	// Reachable from a residential IP (confirmed 2026-08-05 from an M1 connection), so from
	// there this is a parsing question, not an access one. Watsons runs SAP Hybris, which
	// publishes JSON-LD on many storefronts — try that first and report what was actually seen,
	// because this branch cannot be exercised from a datacenter address at all.
	if (r.status === 200) {
		const products = jsonLdProducts(r.body);
		const cands: Candidate[] = [];
		let priced = 0;
		for (const p of products) {
			const price = offerPrice(p);
			if (price == null) continue;
			priced++;
			const c = candidateFrom(String(p.name ?? ""), price);
			if (c) cands.push(c);
		}
		return {
			vendor: "Watsons Pharmacy",
			tier: "fetch",
			reachable: true,
			detail: `HTTP 200, ${r.body.length}B, ${products.length} JSON-LD products, ${priced} priced, ${cands.length} with a size`,
			candidates: cands,
			verdict: cands.length ? "works" : "no-data",
			fix: cands.length
				? "Reachable AND parseable from this address. Watsons is a normal fetch-tier shop from residential — no CDP, no cookie minting."
				: products.length
					? "Reachable, JSON-LD present, but no size in the titles — likely needs the product page for pack size, same as MyProtein."
					: `Reachable (${r.body.length}B) but NO products over plain fetch — the storefront is an Angular SPA on SAP Commerce (\`occ-backend-base-url: https://api.watsons.com.sg\`), so \`/search?text=\` returns a 6.5KB generic fallback and guessed OCC paths (/occ/v2/wtcsg/products/search) 404. **Use the browser tier: \`--browser --headed\` renders it fine** (measured 2026-08-11 from residential: 54 price nodes, 1 ld+json). ⚠️ The 2026-08-05 note here used to call this a dead end — "a real browser renders only the FOOTER, the product API never yields, it needs Bot-Manager-valid cookies from an aged session". **That was drawn from a HEADLESS run and is wrong.** Headless is detected by this site exactly as it is by Carousell; headed clears it with no cookie minting and no login. Next step is the same as any browser-tier shop: pin the product-card selector.`,
		};
	}

	return {
		vendor: "Watsons Pharmacy",
		tier: "fetch",
		reachable: false,
		detail: `HTTP ${r.status}${r.server ? `, server=${r.server}` : ""}`,
		candidates: [],
		verdict: r.status === 200 ? "no-data" : "blocked",
		fix:
			r.status === 200
				? "Got through — the edge deny was not applied to this IP. If you are on a residential connection, that is the expected result and Watsons is scrapeable from here."
				: "⚠️ NOT a bot challenge — a flat Akamai EDGE DENY. Evidence (2026-08-05): `robots.txt` itself 403s, the body is a 296-byte errors.edgesuite.net 'Access Denied', and NO `_abck`/`bm_sz` cookies are ever set — so Bot Manager never even scores the request. A real headed Chrome is refused identically. That pattern means the IP, not the client: run this probe from the RESIDENTIAL runner (the laptop that already scans Sheng Siong), not from a datacenter IP. A headed-Chrome/cookie trick cannot fix an address-based deny.",
	};
}

/**
 * Where this process actually appears to come from.
 *
 * ⚠️ Worth printing on every run, because "blocked" means two different things. Watsons
 * denies datacenter IPs at the Akamai edge while FairPrice and Guardian serve them happily,
 * so the SAME probe gives opposite answers from a cloud shell and from the user's laptop —
 * and without this line you cannot tell which result you are looking at. This is the same
 * split that forced the Sheng Siong scan onto a residential runner in the first place.
 */
async function egress(): Promise<string> {
	try {
		const ctl = new AbortController();
		const t = setTimeout(() => ctl.abort(), 8000);
		const res = await fetch("https://ipinfo.io/json", { signal: ctl.signal });
		clearTimeout(t);
		const d: any = await res.json();
		const org = String(d.org ?? "");
		// ⚠️ Match on what an ISP CALLS ITSELF, not on a list of brand names. The first version
		// of this checked for "m1 " and duly flagged `AS4773 MobileOne Ltd. Mobile/Internet
		// Service Provider Singapore` — the user's actual home connection — as a datacenter.
		// A false alarm here is expensive: it tells you to distrust the one result that is real.
		const isp = /internet service provider|broadband|telecom|mobile|fibre|fiber|cable|singtel|starhub|mobileone|myrepublic|simba/i.test(org);
		const hosting = /datacamp|cdn77|digitalocean|linode|ovh|hetzner|amazon|aws|google cloud|azure|vultr|m247|choopa|leaseweb|hosting|vpn/i.test(org);
		const warn = hosting || !isp;
		return `${d.ip} · ${d.city ?? "?"}, ${d.country ?? "?"} · ${org}${
			warn
				? "  ⚠️ looks like a DATACENTER/VPN address — some shops deny these outright, so a 403 here may say nothing about the shop"
				: "  ✓ residential/ISP address"
		}`;
	} catch {
		return "(could not determine)";
	}
}

async function probeCarousellFetch(term: string): Promise<ProbeResult> {
	const url = `https://www.carousell.sg/search/${encodeURIComponent(term)}`;
	const r = await get(url).catch((e) => ({ status: 0, body: String(e), finalUrl: url, server: "" }));
	const cards = (r.body.match(/\/p\/[a-z0-9-]+-\d+\//gi) ?? []).length;
	return {
		vendor: "Carousell (search)",
		tier: "fetch",
		reachable: r.status === 200,
		detail: `HTTP ${r.status}, ${r.body.length}B, ${cards} listing links${r.server ? `, server=${r.server}` : ""}`,
		candidates: [],
		verdict: cards > 5 ? "works" : "no-data",
		fix:
			cards > 5
				? "Listings are in the static HTML — no browser needed for search after all."
				: "Cloudflare serves a shell to bare fetch. Search needs the BROWSER tier (--browser); a browser rendered 188 cards on 2026-08-04. The LISTING PAGES are plain-fetchable, so only discovery needs Chrome.",
	};
}

/** The half of Carousell that needs no browser: a listing page's JSON-LD offer. */
async function probeCarousellListing(listingUrl: string): Promise<ProbeResult> {
	const r = await get(listingUrl);
	const offer = r.body.match(/"offers"\s*:\s*\{[^}]*"price"\s*:\s*"?([\d.]+)"?[^}]*\}/i);
	const cond = r.body.match(/"itemCondition"\s*:\s*"https:\/\/schema\.org\/(\w+)"/i);
	const name = r.body.match(/<title>([^<]{4,160})<\/title>/i);
	const cands: Candidate[] = [];
	if (offer && name) {
		const c = candidateFrom(name[1], Number(offer[1]), listingUrl);
		if (c) cands.push(c);
	}
	return {
		vendor: "Carousell (listing page)",
		tier: "fetch",
		reachable: r.status === 200,
		detail: `HTTP ${r.status}, ${r.body.length}B, price=${offer?.[1] ?? "—"}, condition=${cond?.[1] ?? "—"}`,
		candidates: cands,
		verdict: offer ? "works" : "no-data",
		fix: offer
			? "JSON-LD Offer carries price, currency AND machine-readable itemCondition — 'new only' is a deterministic filter, not a title guess."
			: "No JSON-LD offer found — re-check the listing URL.",
	};
}

async function probeShopee(term: string): Promise<ProbeResult> {
	const api = `https://shopee.sg/api/v4/search/search_items?by=relevancy&keyword=${encodeURIComponent(
		term,
	)}&limit=10&newest=0&order=desc&page_type=search&version=2`;
	const ctl = new AbortController();
	const t = setTimeout(() => ctl.abort(), 20_000);
	let detail = "";
	let needsLogin = false;
	try {
		const res = await fetch(api, {
			headers: { ...HEADERS, Accept: "application/json", Referer: "https://shopee.sg/", "x-api-source": "pc" },
			signal: ctl.signal,
		});
		const body = await res.text();
		needsLogin = /is_login"\s*:\s*false|90309999/.test(body);
		detail = `API HTTP ${res.status}${needsLogin ? ", error 90309999 (is_login:false)" : ""}`;
	} catch (e: any) {
		detail = `API failed: ${e.message}`;
	} finally {
		clearTimeout(t);
	}
	return {
		vendor: "Shopee",
		tier: "fetch",
		reachable: false,
		detail,
		candidates: [],
		verdict: needsLogin ? "needs-login" : "blocked",
		fix: needsLogin
			? "AUTH wall, not a fingerprint wall — every anonymous route returns error 90309999 / is_login:false, and the browser is redirected to /verify/traffic/error with a 'Login Required' page. Fix: sign in ONCE by hand in a persisted Chrome profile, then read over CDP. Run: npm run vendor-probe -- \"<term>\" --browser --headed --login shopee"
			: "Unexpected response — re-inspect before assuming the wall changed.",
	};
}

// --- browser tier -----------------------------------------------------------

const CAROUSELL_EXTRACT = `(() => {
  const seen = new Set(); const out = [];
  for (const a of document.querySelectorAll('a[href*="/p/"]')) {
    const href = (a.getAttribute('href')||'').split('?')[0];
    const text = (a.innerText||'').replace(/\\s+/g,' ').trim();
    if (!href || seen.has(href) || text.length < 10) continue;
    seen.add(href);
    const m = text.match(/S\\$\\s?([\\d,]+(?:\\.\\d+)?)/);
    out.push({ title: text.replace(/S\\$\\s?[\\d,.]+/,'').replace(/\\b(New|Used|Buyer Protection)\\b/g,'').replace(/\\s+/g,' ').trim(),
               price: m ? Number(m[1].replace(/,/g,'')) : null,
               used: /\\bUsed\\b/.test(text), href });
  }
  return out.slice(0, 60);
})()`;

/**
 * ⚠️ **`blocked` tests the PATH, never the whole href.** It used to be
 * `/verify\/traffic|login/i.test(location.href)`, which matched the substring "login"
 * anywhere in the URL — including Shopee's `?is_from_login=true`, the query parameter it
 * appends when a sign-in SUCCEEDS and it returns you to the page you asked for. So the one
 * URL that proves the session works was reported as "still bounced", with the user's own
 * account name visible in the very `head` text printed beside it (measured 2026-08-11).
 *
 * A login WALL is a path — `/buyer/login`, `/verify/traffic/error`. A login RESULT is a
 * query string. Reading only the path keeps the two apart.
 */
const GENERIC_PROBE = `(() => {
  const p = location.pathname;
  return {
    blocked: /verify\\/traffic/i.test(p) || /(^|\\/)(login|signin)(\\/|$)/i.test(p),
    href: location.href,
    textLen: document.body.innerText.length,
    head: document.body.innerText.replace(/\\s+/g,' ').slice(0, 240),
    ldjson: [...document.querySelectorAll('script[type="application/ld+json"]')].length,
    priceNodes: [...document.querySelectorAll('[class*="price" i],[itemprop="price"]')].length
  };
})()`;

async function probeCarousellBrowser(term: string, headed: boolean): Promise<ProbeResult> {
	const url = `https://www.carousell.sg/search/${encodeURIComponent(term)}`;
	try {
		const res = await evaluateInPage(url, CAROUSELL_EXTRACT, { headed, settleMs: 7000 });
		const rows = (res.value as any[]) ?? [];
		const cands: Candidate[] = [];
		let noSize = 0;
		let multiSize = 0;
		for (const r of rows) {
			if (r.used || !r.price) continue;
			const size = marketplaceSize(r.title);
			if (!size.ok) {
				size.reason === "multi-size" ? multiSize++ : noSize++;
				continue;
			}
			const c = candidateFrom(r.title, r.price, `https://www.carousell.sg${r.href}`);
			if (c) cands.push(c);
		}
		return {
			vendor: "Carousell (search)",
			tier: "browser",
			reachable: true,
			detail: `${rows.length} listings rendered; ${cands.length} priced+sized, ${noSize} no size, ${multiSize} multi-size (rejected)`,
			candidates: cands,
			verdict: cands.length ? "works" : "no-data",
			fix: cands.length
				? "Browser for search, plain fetch for the listing page. No login anywhere."
				: // ⚠️ **Zero cards HEADLESS is the expected answer, not a finding.**
					// `carousell.ts` measured it and says so: "a headless Chrome renders zero
					// cards here — it is detected". Reporting "check the card selector" here
					// sends the next person after a selector that is not broken, which is a
					// worse outcome than saying nothing. Only a HEADED zero is a real bug.
					!headed
					? "You ran HEADLESS, which Carousell detects — zero cards is the known outcome, not a broken selector (see `carousell.ts`). Re-run with --headed before concluding anything."
					: `${rows.length} card(s) rendered headed but none survived parsing — NOW the card selector is worth checking.`,
		};
	} catch (e: any) {
		return {
			vendor: "Carousell (search)",
			tier: "browser",
			reachable: false,
			detail: e.message,
			candidates: [],
			verdict: "error",
			fix: "Browser tier failed to launch. Needs Chrome installed (or CHROME_PATH).",
		};
	}
}

/**
 * @param settleMs How long the window stays open before the page is read.
 *
 * ⚠️ **The login tier needs minutes, not seconds.** `evaluateInPage` sleeps for this long,
 * reads the page, then kills Chrome — so the 7 s default gave a human no time at all to
 * sign in, and the tier could never do the one thing it exists for. It would report
 * "still bounced", which reads as *the site refused us* rather than *we closed the window
 * before you could type*.
 */
async function probeViaBrowser(
	vendor: string,
	url: string,
	headed: boolean,
	profile?: string,
	settleMs = 7000,
): Promise<ProbeResult> {
	try {
		const res = await evaluateInPage(url, GENERIC_PROBE, { headed, settleMs, persistProfile: profile });
		const v = res.value as any;
		return {
			vendor,
			tier: profile ? "login" : "browser",
			reachable: !v.blocked,
			detail: `${v.blocked ? "REDIRECTED → " + v.href : "rendered"}; text ${v.textLen}B, ${v.ldjson} ld+json, ${v.priceNodes} price nodes`,
			candidates: [],
			verdict: v.blocked ? "needs-login" : v.priceNodes > 0 || v.ldjson > 0 ? "works" : "no-data",
			fix: v.blocked
				? `Still bounced: ${v.head.slice(0, 120)}. Sign in by hand in the window this opens (profile persists at .sessions/), then re-run.`
				: v.priceNodes > 0
					? "Renders with prices in the DOM — a browser-tier adapter will work. Next step: pin the product-card selector."
					: // ⚠️ A near-empty render is a BLOCK wearing the costume of an empty page.
						// A real search result is tens of kilobytes of text; a bot wall is a few
						// hundred bytes and no ld+json. Calling that "check the search URL" is
						// the wrong diagnosis and costs an afternoon.
						v.textLen < 2000
						? `Only ${v.textLen}B of text rendered — a challenge, an interstitial or a MAINTENANCE page, not an empty result page. (Check the fetch tier above: a 503 Magento maintenance body means the shop is simply down and there is nothing to fix here.)` +
							(headed ? " Headed already, so this site wants a warmed profile: try --login." : " Re-run with --headed first; headless is detected by several of these sites.")
						: "Rendered but no prices found — check the search URL.",
		};
	} catch (e: any) {
		return { vendor, tier: "browser", reachable: false, detail: e.message, candidates: [], verdict: "error", fix: "Browser launch failed — is Chrome installed? Set CHROME_PATH." };
	}
}

// ---------------------------------------------------------------------------

const ICON: Record<ProbeResult["verdict"], string> = {
	works: "✅",
	blocked: "🔴",
	"no-data": "🟠",
	"needs-login": "🔑",
	error: "💥",
};

function report(r: ProbeResult): void {
	console.log(`\n${ICON[r.verdict]}  ${r.vendor}  [${r.tier}]  — ${r.verdict}`);
	console.log(`    ${r.detail}`);
	if (r.candidates.length) {
		const { pick, median, rejected } = cheapestPlausible(r.candidates);
		const rejectedSet = new Set(rejected);
		const kept = r.candidates.filter((c) => !rejectedSet.has(c)).sort((a, b) => a.pricePer100g - b.pricePer100g);
		console.log(`    ${r.candidates.length} comparable candidate(s); median $${median?.toFixed(3)}/100g`);
		for (const c of kept.slice(0, 5)) {
			console.log(
				`      $${c.pricePer100g.toFixed(3)}/100g  ·  S$${c.priceSgd} / ${c.sizeText} (${c.grams}g)  ·  ${c.title.slice(0, 62)}`,
			);
		}
		if (rejected.length) {
			console.log(`    ⚠️  ${rejected.length} rejected as implausibly cheap (likely mis-sized or a scam):`);
			for (const c of rejected.slice(0, 3)) {
				console.log(`      $${c.pricePer100g.toFixed(3)}/100g  ·  S$${c.priceSgd} / ${c.grams}g  ·  ${c.title.slice(0, 62)}`);
			}
		}
		if (pick) console.log(`    → cheapest PLAUSIBLE: $${pick.pricePer100g.toFixed(3)}/100g — ${pick.title.slice(0, 62)}`);
	}
	console.log(`    fix: ${r.fix}`);
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const term = argv.find((a) => !a.startsWith("--")) ?? "whey protein";
	const flag = (name: string): string | undefined => {
		const i = argv.indexOf(`--${name}`);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const useBrowser = argv.includes("--browser");
	const headed = argv.includes("--headed");
	const loginVendor = (flag("login") ?? "").toLowerCase();
	const only = (flag("only") ?? "").toLowerCase().split(",").filter(Boolean);
	const wanted = (name: string) => !only.length || only.some((o) => name.toLowerCase().includes(o));

	console.log(`\nVendor probe — term: "${term}"${useBrowser ? "  (+browser tier)" : ""}`);
	console.log(`Calling from: ${await egress()}`);
	console.log("Writes nothing. Reports whether each shop can yield a price AND a pack size.\n" + "─".repeat(78));

	const jobs: Promise<ProbeResult>[] = [];
	if (wanted("iherb")) jobs.push(probeIherb(term));
	if (wanted("myprotein")) jobs.push(probeMyProtein(term));
	if (wanted("guardian")) jobs.push(probeGuardian(term));
	if (wanted("watsons")) jobs.push(probeWatsons(term));
	if (wanted("carousell")) jobs.push(probeCarousellFetch(term));
	if (wanted("shopee")) jobs.push(probeShopee(term));

	const results = await Promise.all(jobs.map((p) => p.catch((e): ProbeResult => ({
		vendor: "?", tier: "fetch", reachable: false, detail: e.message, candidates: [], verdict: "error", fix: "threw",
	}))));
	results.forEach(report);

	// A known Carousell listing exercises the free half of that vendor without a browser.
	if (wanted("carousell")) {
		const listing = flag("listing") ?? "https://www.carousell.sg/p/muscleblaze-mb-biozorb-performance-whey-protein-1453681028/";
		report(await probeCarousellListing(listing).catch((e): ProbeResult => ({
			vendor: "Carousell (listing page)", tier: "fetch", reachable: false, detail: e.message,
			candidates: [], verdict: "error", fix: "threw",
		})));
	}

	if (useBrowser) {
		console.log("\n" + "─".repeat(78) + "\nBrowser tier (real Chrome over CDP)\n" + "─".repeat(78));
		// ⚠️ iHerb was missing from this tier while its OWN fetch-tier `fix` text said
		// "Re-run with --browser" — an instruction that silently did nothing, because
		// `--browser` only ever ran the four below. A probe whose advice cannot be
		// followed is worse than one that gives none: it reads as "tried that, no luck".
		if (wanted("iherb"))
			report(await probeViaBrowser("Iherb", `https://sg.iherb.com/search?kw=${encodeURIComponent(term)}`, headed));
		if (wanted("carousell")) report(await probeCarousellBrowser(term, headed));
		if (wanted("guardian"))
			report(await probeViaBrowser("Guardian Pharmacy", `https://www.guardian.com.sg/catalogsearch/result/?q=${encodeURIComponent(term)}`, headed));
		if (wanted("watsons"))
			report(await probeViaBrowser("Watsons Pharmacy", `https://www.watsons.com.sg/search?text=${encodeURIComponent(term)}`, headed));
		if (wanted("shopee")) {
			const profile = loginVendor === "shopee" ? ".sessions/chrome-shopee" : undefined;
			// Generous by default so there is time to sign in by hand; `--hold <seconds>`
			// overrides it, and a profile that is ALREADY signed in wants the short wait.
			const holdMs = Number(flag("hold") ?? (profile ? 180 : 7)) * 1000;
			if (profile) {
				console.log(
					`\n🔑 Shopee: a Chrome window is opening on a PERSISTED profile (.sessions/chrome-shopee).` +
						`\n   Sign in BY HAND if prompted — this script never types credentials.` +
						`\n   The window stays open ${Math.round(holdMs / 1000)}s, then the page is read and Chrome closes.` +
						`\n   The session is kept, so later runs need no login and can use --hold 10.`,
				);
			}
			report(
				await probeViaBrowser(
					"Shopee",
					`https://shopee.sg/search?keyword=${encodeURIComponent(term)}`,
					headed || !!profile,
					profile,
					holdMs,
				),
			);
		}
	} else {
		console.log("\n(Run again with --browser to test the browser tier: Iherb, Carousell search, Guardian, Watsons, Shopee.)");
	}

	console.log("\n" + "─".repeat(78));
	console.log("Legend: ✅ works  🟠 reachable but no usable data  🔴 blocked  🔑 needs a signed-in session  💥 error\n");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
