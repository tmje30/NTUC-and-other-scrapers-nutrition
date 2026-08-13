import { runScan, sgtDate, type ScanFile } from "./scan";
import { commitScanFile, dispatchRebuild, readScanFile } from "./github";

/**
 * Sheng Siong scanner, in Cloudflare.
 *
 * Replaces the laptop for both paths the system needs: the Rescan button
 * (on demand) and the morning scan (09:00–11:00 SGT, retrying until one works).
 * Sheng Siong challenges any address outside Singapore — it is the COUNTRY, not
 * residential-vs-datacenter — so everything here exists to guarantee the scan
 * runs from Singapore and to refuse to publish if it cannot.
 *
 * ⚠️⚠️ **BOTH paths go through the Durable Object, and that is not obvious.**
 * The first design had the on-demand path skip it, reasoning that a request from
 * Singapore is placed in Singapore automatically. That is true of a tap from the
 * user's phone — but the tap does NOT reach this Worker. The deals page is public
 * and cannot hold a secret, so the button fires `repository_dispatch` and
 * **GitHub Actions** calls this Worker — from a US Azure runner. Placed near that
 * request, the Worker would run in the US and be challenged on every search.
 * So the DO with `locationHint: "apac"` is what puts the scan in Singapore on
 * every path, and the placement probe's result is load-bearing for all of them.
 *
 * Measured 2026-08-12: `apac` placed 15 of 16 objects in SIN and they stayed put.
 */

export interface Env {
	SCAN: DurableObjectNamespace;
	/** Fine-grained PAT, this repo only, Contents: read and write. */
	GITHUB_TOKEN: string;
	/** Shared secret; callers present it as `X-Scan-Secret`. */
	SCAN_SECRET: string;
	REPO: string;
	TARGETS_URL: string;
}

const SCAN_PATH = "data/shengsiong-latest.json";

/**
 * Which Cloudflare datacenter this object is being served from.
 *
 * ⚠️⚠️ **Read `colo`, NEVER `loc`.** This cost a wrong conclusion on 2026-08-12.
 * `cdn-cgi/trace` fetched from inside a Worker reports `loc` as the *original
 * caller's* country, not the object's: with the laptop on a Danish VPN, objects
 * demonstrably serving from `SIN` reported `loc=DK`. The placement probe keyed its
 * verdict on `loc` and therefore read "Singapore" partly because the laptop was in
 * Singapore that night — its 15-of-16 result was overstated. `colo` varies
 * independently (SIN / NRT / ICN) and is the real signal.
 *
 * ⚠️ Even `colo` is only a hint. What actually decides whether Sheng Siong answers
 * is the country its own servers see, so the authoritative test is the DDP upgrade
 * itself — a `200` instead of a `101` is the challenge page. `colo` is reported for
 * diagnosis; `reachable()` is what gates the scan.
 */
async function whereAmI(): Promise<{ colo: string }> {
	try {
		const res = await fetch("https://cloudflare.com/cdn-cgi/trace", { headers: { "cache-control": "no-cache" } });
		const t = Object.fromEntries(
			(await res.text())
				.trim()
				.split("\n")
				.map((l) => l.split("=")),
		);
		return { colo: t.colo ?? "?" };
	} catch {
		return { colo: "?" };
	}
}

/**
 * Can THIS object actually talk to Sheng Siong?
 *
 * One upgrade attempt, nothing sent. `101` means the country is right; `200` is
 * Incapsula's challenge page, which is what every address outside Singapore gets.
 * This is the only test that answers the question that matters.
 */
async function reachable(): Promise<boolean> {
	try {
		const res = await fetch("https://shengsiong.com.sg/websocket", {
			headers: { Upgrade: "websocket" },
		});
		const ok = res.status === 101 && !!res.webSocket;
		// Close it immediately — this is a probe, not the scan's connection.
		if (ok) {
			try {
				res.webSocket!.accept();
				res.webSocket!.close();
			} catch {
				/* ignore */
			}
		}
		return ok;
	} catch {
		return false;
	}
}

/**
 * Whether a scan file is today's and is an actual scan.
 *
 * ⚠️ Mirrors `isUsableScan` in `stores/shengsiong-file.ts`, including the part
 * that catches the 2026-08-09 failure: a file **dated today that searched zero
 * terms is not fresh**. Getting this wrong in the "should I retry?" check would
 * make the 09:00–11:00 window stop retrying after a scan that published nothing.
 */
function isUsableScan(raw: any, today: string): boolean {
	if (raw?.date !== today) return false;
	if (!raw?.results || typeof raw.results !== "object") return false;
	const terms = typeof raw.terms === "number" && Number.isFinite(raw.terms) ? raw.terms : Object.keys(raw.results).length;
	return terms > 0;
}

export class ScanRunner {
	constructor(
		private state: DurableObjectState,
		private env: Env,
	) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const force = url.searchParams.get("force") === "1";
		const limit = Number(url.searchParams.get("limit")) || undefined;
		const dryRun = url.searchParams.get("dryRun") === "1";
		const source = url.searchParams.get("source") ?? "cloudflare";

		const where = await whereAmI();

		// A cheap yes/no on placement, used by the caller to pick a usable object
		// before committing to a full scan.
		if (url.searchParams.get("probe") === "1") {
			return Response.json({ ok: await reachable(), ...where });
		}

		// ⚠️ Refuse rather than scan-and-fail. Outside Singapore every search is
		// challenged, and "blocked" has been misread as a WAF policy change three
		// times in this project — twice from a VPN, once from a colo. Report the
		// datacenter and let the caller try a differently-placed object.
		if (!(await reachable())) {
			return Response.json(
				{ ok: false, reason: "unreachable-from-here", ...where, hint: "no 101 upgrade; object is outside SG" },
				{ status: 503 },
			);
		}

		const today = sgtDate();
		if (!force) {
			const existing = await readScanFile(this.env.REPO, SCAN_PATH, this.env.GITHUB_TOKEN);
			if (isUsableScan(existing, today)) {
				// The retry window's normal outcome after the first success.
				return Response.json({ ok: true, status: "already-fresh", date: today, ...where });
			}
		}

		let file: ScanFile;
		try {
			const termsParam = url.searchParams.get("terms");
			file = await runScan({
				targetsUrl: this.env.TARGETS_URL,
				source,
				limit,
				// Testing affordance only. ⚠️ Guarded by `dryRun`: an overridden term
				// list must never be able to overwrite the real scan file with a
				// two-term "scan" that `isUsableScan` would happily call fresh.
				termsOverride: termsParam && dryRun ? termsParam.split("|").filter(Boolean) : undefined,
			});
		} catch (e: any) {
			return Response.json({ ok: false, reason: "scan-failed", error: String(e?.message ?? e), ...where }, { status: 502 });
		}

		const products = Object.values(file.results).reduce((s, a) => s + a.length, 0);

		// `dryRun` returns the scan without writing it — this is how the port is
		// diffed against the Node scanner before it is ever allowed near the repo.
		if (dryRun) {
			return Response.json({ ok: true, status: "dry-run", terms: file.terms, products, ...where, file });
		}

		const { commit } = await commitScanFile({
			repo: this.env.REPO,
			path: SCAN_PATH,
			token: this.env.GITHUB_TOKEN,
			content: JSON.stringify(file),
			message: `data: Sheng Siong scan ${file.date} (${source})`,
		});
		await dispatchRebuild(this.env.REPO, this.env.GITHUB_TOKEN);

		return Response.json({ ok: true, status: "scanned", terms: file.terms, products, commit, ...where });
	}
}

/**
 * Find an object that can actually reach Sheng Siong.
 *
 * ⚠️⚠️ **This loop is the whole answer to placement, and a single fixed name is
 * NOT.** The first version used one name (`sheng-siong-sg`) on the reasoning that
 * one long-lived object gets placed once and stays. It does — and the very first
 * one landed in **ICN (Seoul)** and stayed there, permanently unable to scan. The
 * `apac` hint covers Tokyo, Seoul, Sydney and Singapore alike, so betting the
 * system on one draw was the mistake.
 *
 * Placement per name is sticky, so a name that works keeps working and this
 * normally succeeds on the first candidate. Measured hit rate for `apac` is
 * roughly half, so eight candidates make a failed pick vanishingly unlikely while
 * costing one cheap upgrade attempt each.
 */
const CANDIDATES = Array.from({ length: 8 }, (_, i) => `sheng-siong-sg-${i}`);

async function pickStub(env: Env): Promise<{ stub: DurableObjectStub; name: string; tried: string[] } | null> {
	const tried: string[] = [];
	for (const name of CANDIDATES) {
		const s = env.SCAN.get(env.SCAN.idFromName(name), { locationHint: "apac" });
		try {
			const res = await s.fetch(new Request("https://scan/?probe=1"));
			const body: any = await res.json();
			tried.push(`${name}:${body?.colo ?? "?"}${body?.ok ? "✓" : "✗"}`);
			if (body?.ok) return { stub: s, name, tried };
		} catch {
			tried.push(`${name}:error`);
		}
	}
	return null;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// ⚠️ Fail closed, and check the secret before anything else. The URL is
		// public the moment it is guessed, and an open endpoint here is a stranger
		// able to run unlimited scans against Sheng Siong in the user's name. A
		// missing SCAN_SECRET in the environment fails the same way rather than
		// opening up — the relay does exactly this, for exactly this reason.
		if (!env.SCAN_SECRET || request.headers.get("X-Scan-Secret") !== env.SCAN_SECRET) {
			return new Response("unauthorized", { status: 401 });
		}
		if (url.pathname !== "/scan") return new Response("not found", { status: 404 });

		// ⚠️ Fail closed on a missing token too. Without it the scan would run in
		// full, hammer Sheng Siong for a minute, and then fail at the commit — so
		// check before doing the expensive thing, not after.
		if (!env.GITHUB_TOKEN && url.searchParams.get("dryRun") !== "1") {
			return Response.json({ ok: false, reason: "no-github-token" }, { status: 503 });
		}

		const picked = await pickStub(env);
		if (!picked) {
			return Response.json(
				{ ok: false, reason: "no-singapore-placement", tried: CANDIDATES.length },
				{ status: 503 },
			);
		}
		const res = await picked.stub.fetch(new Request(`https://scan/${url.search}`, { method: "GET" }));
		// Which object served it, so a drift can be seen in the response rather than
		// inferred from a scan that quietly stopped working.
		const body: any = await res.json();
		return Response.json({ ...body, object: picked.name, probes: picked.tried }, { status: res.status });
	},

	/**
	 * The morning window: every 15 min over 01:00–02:45 UTC plus a final 03:00 UTC
	 * run — 09:00 to 11:00 SGT. The literal expressions live in `wrangler.toml`
	 * (writing them here would close this comment: the slash-star sequence in a
	 * step value is a comment terminator).
	 *
	 * ⚠️ Every run after the first success is a no-op — the DO checks the committed
	 * file and returns `already-fresh` without opening a socket. "Stop when it
	 * succeeds" is that check, not stored state: a Worker holds nothing between
	 * invocations, and the committed file is the only durable answer to "did the
	 * morning scan work yet?".
	 */
	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			(async () => {
				if (!env.GITHUB_TOKEN) {
					console.log("cron scan: skipped — no GITHUB_TOKEN set");
					return;
				}
				const picked = await pickStub(env);
				if (!picked) {
					console.log("cron scan: no candidate object reached Sheng Siong");
					return;
				}
				const r = await picked.stub.fetch(new Request("https://scan/?source=cloudflare-cron"));
				// Cron failures are invisible by definition — nobody is watching at
				// 09:00. This log is what `wrangler tail` shows, and the retry is the
				// next slot in the window.
				console.log(`cron scan via ${picked.name}: ${r.status} ${await r.text()}`);
			})(),
		);
	},
};
