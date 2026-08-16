/**
 * Does Carousell answer a Cloudflare Worker in Singapore?
 *
 * A throwaway probe, not part of the system. Same shape and same rules as
 * `worker.mjs` beside it — run with `wrangler dev --remote`, read `colo`, delete.
 *
 * **The question.** Moving new-item pricing off the laptop is blocked on Carousell
 * and nothing else. Measured 2026-08-16, run 31929132686: a **US** GitHub runner
 * (Azure, Phoenix) gets **403** from Carousell — on the search page *and* on a
 * listing page, which is plain HTTP and works fine from the laptop. So the refusal
 * is at the address, not the browser.
 *
 * ⚠️ **But that runner differed from the laptop in TWO ways at once** — US *and*
 * datacenter — so it cannot say which one Carousell objects to. This probe changes
 * exactly one of them: a datacenter address that is **in Singapore**.
 *
 *   200 here → the block is GEOGRAPHIC. Carousell can follow Sheng Siong onto
 *              Cloudflare, and only the browser question is left.
 *   403 here → the block is DATACENTER-WIDE. Carousell stays on the laptop, and
 *              that is settled rather than assumed.
 *
 * ⚠️ **Read `colo` before believing anything below it.** `--remote` places the code
 * near the *caller*, so a laptop on a foreign VPN silently probes from that country.
 * That confound has been mistaken for a WAF change three times in this project — see
 * `probe/README.md`, runs 1 and 2. Check `curl https://cloudflare.com/cdn-cgi/trace`
 * first; this probe reports `colo` in its own output so the result carries its own
 * evidence.
 *
 * ⚠️ A **listing page** is the load-bearing test, not the search page. Search needs a
 * real browser everywhere (Cloudflare serves a shell to bare `fetch`), so a shell
 * here would say nothing. Listing pages are plain-fetchable and carry a JSON-LD
 * `Offer` — if they answer, verification can move to the cloud even if discovery
 * cannot.
 *
 * ## What was measured (2026-08-16) — and the search result was a surprise
 *
 * From `colo=SIN`, all three plain `fetch` calls, **no browser**:
 *
 * | target | status | bytes | note |
 * | --- | --- | --- | --- |
 * | homepage | 200 | 346 KB | |
 * | **search** | **200** | **2.29 MB** | **47 listing links** |
 * | listing | 200 | 443 KB | `hasJsonLdOffer: true` |
 *
 * 1. **The US 403 is GEOGRAPHIC.** A US runner is refused even on listing pages,
 *    which answer 200 from Singapore. That was the question this probe was written
 *    for, and it is settled.
 *
 * 2. ⚠️⚠️ **"Carousell search needs a real browser" is FALSE from a Worker.** The
 *    search page came back whole, with 47 listing links, to a bare `fetch`. Both
 *    halves of the job — discovery *and* verification — run with no Chrome at all.
 *
 * 3. ⚠️ **Why the codebase believes otherwise: the HTTP CLIENT is the variable.**
 *    From the *same* Singapore address, in the same minute:
 *      - `curl -L`              → **200**, 2.28 MB, 44 listing links
 *      - Cloudflare Worker fetch → **200**, 2.29 MB, 47 listing links
 *      - Node's `fetch` (undici) → **403**, 5.8 KB, 0 links  ← what vendor-probe uses
 *    Same URL, same headers, same `redirect: "follow"`. Cloudflare fingerprints the
 *    TLS handshake, and undici's is the one being refused; the rule is per-path, so
 *    listing pages pass on every client while search does not. This is the glossary's
 *    "the client is an independent variable" entry, pointing the other way from the
 *    Watsons case that produced it.
 *    ⚠️ Consequence: `vendor-probe`'s "Cloudflare serves a shell to bare fetch" is a
 *    statement about **undici**, not about Carousell. Do not read it as the latter.
 *    ⚠️ Also note `probeCarousellFetch` counts links with a trailing slash
 *    (`/\/p\/[a-z0-9-]+-\d+\//`) — real hrefs have none, so its count would read 0
 *    even on a page full of them. Two independent reasons that probe says "no-data".
 *
 * ## Guardian and MyProtein, same run (2026-08-16)
 *
 * | target | status | bytes | signal |
 * | --- | --- | --- | --- |
 * | `myprotein:search` | 200 | 637 KB | JSON-LD Product + Offer, 62 price fields |
 * | `guardian:search` | 200 | 139 KB | nothing — the SPA shell |
 * | `guardian:graphql` | 200 | 93 B | GraphQL syntax error = **endpoint reachable** |
 *
 * 4. **MyProtein works from a Worker.** Access was never the problem: 28 JSON-LD
 *    products, 28 priced. The real work is that **0 of 28 titles carry a pack size**
 *    — MyProtein keeps it in the on-page variant selector — so each product needs a
 *    second fetch. A parsing job, not an access one.
 *
 * 5. **Guardian is the one a Worker does NOT fix, and it is not being blocked.**
 *    The search URL returns the same empty SPA shell to everyone: **139130 bytes to
 *    the Worker and 139130 to undici, byte-for-byte identical.** No client variable
 *    here, unlike Carousell — so the "NO anti-bot, plain 200" note was right.
 *    ⚠️ But its **`/graphql` endpoint answers**, unauthenticated, from both the
 *    laptop and the Worker: `POST {"query":"{__typename}"}` → `{"data":{"@typename"
 *    :"Query"}}` (written with an @ here only to keep this comment legal). That is
 *    the route `vendor-probe` has called "the cheaper long-term route" without
 *    anyone measuring it. It means Guardian needs **no browser either** — it needs a
 *    product query written against that API.
 */

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const HEADERS = {
	"User-Agent": UA,
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-SG,en;q=0.9",
	"Upgrade-Insecure-Requests": "1",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
};

/** Where this object is actually running. ⚠️ `colo`, never `loc` — `loc` is the CALLER's country. */
async function whereAmI() {
	try {
		const res = await fetch("https://cloudflare.com/cdn-cgi/trace", { headers: { "cache-control": "no-cache" } });
		const t = Object.fromEntries(
			(await res.text())
				.trim()
				.split("\n")
				.map((l) => l.split("=")),
		);
		return { colo: t.colo ?? "?", callerLoc: t.loc ?? "?" };
	} catch {
		return { colo: "?", callerLoc: "?" };
	}
}

async function probe(label, url) {
	try {
		const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
		const body = await res.text();
		return {
			label,
			url,
			status: res.status,
			bytes: body.length,
			server: res.headers.get("server") ?? null,
			// The one thing that decides whether verification can move: a listing page
			// carries a JSON-LD Offer. A challenge page never does.
			hasJsonLdOffer: /"@type"\s*:\s*"Offer"/.test(body),
			hasJsonLdProduct: /"@type"\s*:\s*"Product"/.test(body),
			// ⚠️ No trailing slash. `vendor-probe.ts:300` requires one and real hrefs
			// do not have it, so its count reads 0 on a page full of listings.
			listingLinks: new Set(body.match(/\/p\/[a-z0-9-]+\-\d+/gi) ?? []).size,
			// A cheap "are there products here at all" signal that does not depend on
			// knowing each shop's markup: how many times a price-shaped field appears.
			priceMentions: (body.match(/"price"\s*:/gi) ?? []).length,
		};
	} catch (e) {
		return { label, url, status: null, error: String(e?.message ?? e) };
	}
}

/**
 * The other two shops new-item pricing searches.
 *
 * ⚠️ Their known failures are DIFFERENT IN KIND from Carousell's, and the difference
 * decides whether a Worker can help at all:
 *   - **Guardian** is an SPA shell — every URL returns the same ~137 KB page with no
 *     products, at a plain 200 with NO anti-bot (Fastly cache). A Worker cannot fix
 *     that: there is nothing to block and nothing to render. Measured here anyway,
 *     because "no anti-bot" was itself measured with undici and undici was wrong
 *     about Carousell.
 *   - **MyProtein** served a bare `fetch` fine on 2026-08-04; its problem is that
 *     titles carry no pack size, which is a parsing job, not an access one.
 */
const SHOPS = {
	carousell: [
		["carousell:homepage", "https://www.carousell.sg/"],
		["carousell:search", "https://www.carousell.sg/search/whey%20protein"],
	],
	myprotein: [["myprotein:search", "https://www.myprotein.com.sg/search/?q=whey%20protein"]],
	guardian: [
		["guardian:search", "https://www.guardian.com.sg/catalogsearch/result/?q=vitamin%20d"],
		// ⚠️ A GET here is EXPECTED to return a GraphQL syntax error — that is a
		// success, not a failure: a 200 with `Syntax Error: Unexpected <EOF>` proves
		// the endpoint is reachable and speaking GraphQL. Reachability is all this
		// probe is for; whether a product query returns useful rows is separate work.
		["guardian:graphql", "https://www.guardian.com.sg/graphql"],
	],
};

export default {
	async fetch(request) {
		const url = new URL(request.url);
		// A listing URL goes stale as sellers delete listings; let it be overridden
		// rather than editing this file for a 404 that means nothing.
		const listing = url.searchParams.get("listing");
		// `?shops=carousell,guardian` narrows the run; default is all of them.
		const want = (url.searchParams.get("shops") ?? "carousell,myprotein,guardian").split(",");

		const where = await whereAmI();
		const targets = [];
		for (const s of want) targets.push(...(SHOPS[s.trim()] ?? []));
		if (listing) targets.push(["carousell:listing", listing]);

		const results = [];
		for (const [label, target] of targets) results.push(await probe(label, target));

		return Response.json({
			...where,
			// ⚠️ No single verdict any more: these shops fail in different ways, and a
			// rolled-up "works/blocked" would hide the only distinction that matters —
			// a 403 is an access problem a Worker can solve by being in Singapore, an
			// empty 200 is an SPA and it cannot.
			readMe: "403 = access (a Worker in SG may fix it). 200 with no products = SPA shell (a Worker cannot). Compare `bytes` against a known-empty page before calling a 200 a success.",
			note: where.colo === "SIN" ? null : `⚠️ colo=${where.colo}, NOT SIN — this result is about ${where.colo}, not Singapore. Re-run from a Singapore connection.`,
			results,
		});
	},
};
