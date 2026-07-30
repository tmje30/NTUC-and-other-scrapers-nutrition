import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import WebSocket from "ws";

/**
 * Getting past Sheng Siong's Incapsula challenge, for the residential runner.
 *
 * From 2026-07-30 the site answers every request from a plain HTTP client — the
 * homepage included — with an Incapsula JS challenge (HTTP 200 + a script) rather
 * than real content. The DDP WebSocket upgrade gets the same treatment, which is
 * why the scan died with "Unexpected server response: 200" on all 62 searches.
 *
 * Measured, in this order, so the cheapest thing that could work was tried first:
 *
 *   browser-like headers only ......... still challenged
 *   replaying the challenge's cookies .. still challenged (the JS must actually run)
 *   headless Chrome (--headless=new) ... still challenged (headless is detected)
 *   headed Chrome ..................... clears it, and its cookie makes DDP connect
 *
 * So a real browser has to mint the cookie. This launches the installed Chrome
 * with a throwaway profile, lets it solve the challenge the way any visit does,
 * and keeps the resulting cookie. No CAPTCHA is being solved and nothing is being
 * reverse-engineered: a browser visits the site, exactly as a person would, and we
 * reuse that session. Deliberately NOT a challenge-defeat library.
 *
 * Uses `ws` (already a dependency) to speak CDP — no Playwright, no downloads.
 * The cookie is cached and only re-minted when it stops working, so a normal day
 * launches no browser at all.
 */

/** Where the minted cookie lives. Gitignored: it's a session credential. */
const SESSION_PATH = process.env.SS_SESSION_PATH ?? ".sessions/shengsiong.json";

/** Chrome, in the usual places. `CHROME_PATH` wins when set. */
const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
	`${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].filter(Boolean) as string[];

const SITE = "https://shengsiong.com.sg/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A free localhost port for this launch, never a fixed one.
 *
 * Learned the hard way: with a hardcoded port, a Chrome left behind by an earlier
 * run still holds it, the new Chrome silently starts without a debugger, and
 * `/json/list` then answers from the STALE browser. The mint drives a browser
 * that was never sent anywhere, sees the challenge, and reports failure — which
 * is exactly how the first scheduled run failed while a hand-run one worked.
 */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as AddressInfo).port;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

/**
 * Shut the browser down for certain.
 *
 * Three layers, because each one alone was seen to leave Chrome running, and a
 * survivor holds the debug port and poisons the NEXT run:
 *
 *   1. `Browser.close` over CDP — the polite way, and the only one that lets
 *      Chrome tidy up its own profile.
 *   2. kill the spawned pid's tree — but note Chrome's first process often exits
 *      immediately and the real browser re-parents, so this frequently hits
 *      nothing. It was the only layer at first, and 10 processes survived it.
 *   3. sweep anything still holding OUR temp profile path. Precise by
 *      construction: that path is unique to this launch, so the user's own Chrome
 *      can never match.
 */
async function shutdown(browserWs: string | null, pid: number | undefined, profile: string): Promise<void> {
	if (browserWs) {
		try {
			await cdp(browserWs, "Browser.close");
			await sleep(1500);
		} catch {
			/* fall through to the blunter layers */
		}
	}
	if (pid) {
		try {
			if (process.platform === "win32") {
				spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
			} else {
				process.kill(-pid, "SIGKILL");
			}
		} catch {
			/* already gone */
		}
	}
	if (process.platform === "win32") {
		const token = profile.replace(/\\/g, "\\\\");
		spawnSync(
			"powershell",
			[
				"-NoProfile",
				"-Command",
				`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
					`Where-Object { $_.CommandLine -like '*${token.split(/[\\/]/).pop()}*' } | ` +
					`ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
			],
			{ stdio: "ignore" },
		);
	}
}

interface StoredSession {
	cookie: string;
	mintedAt: string;
}

export function findChrome(): string | null {
	return CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

/** The cached cookie, or null when there isn't one. Never throws. */
export function cachedCookie(): string | null {
	try {
		const s = JSON.parse(readFileSync(SESSION_PATH, "utf8")) as StoredSession;
		return typeof s.cookie === "string" && s.cookie ? s.cookie : null;
	} catch {
		return null;
	}
}

function storeCookie(cookie: string): void {
	try {
		mkdirSync(dirname(SESSION_PATH), { recursive: true });
		writeFileSync(
			SESSION_PATH,
			`${JSON.stringify({ cookie, mintedAt: new Date().toISOString() } satisfies StoredSession, null, 2)}\n`,
			"utf8",
		);
	} catch (e: any) {
		console.error(`Incapsula: could not cache the session (${e.message}) — continuing.`);
	}
}

/** One CDP command over the target's debugger socket. */
function cdp(sessionUrl: string, method: string, params: unknown = {}): Promise<any> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(sessionUrl);
		const t = setTimeout(() => {
			ws.close();
			reject(new Error(`CDP ${method} timed out`));
		}, 30_000);
		ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
		ws.on("message", (raw: WebSocket.RawData) => {
			const d = JSON.parse(raw.toString());
			if (d.id !== 1) return;
			clearTimeout(t);
			ws.close();
			d.error ? reject(new Error(`CDP ${method}: ${d.error.message}`)) : resolve(d.result);
		});
		ws.on("error", (e: Error) => {
			clearTimeout(t);
			reject(e);
		});
	});
}

/**
 * Launch Chrome, visit the site, and take the Incapsula cookies it earns.
 *
 * Two navigations on purpose: the first lands on the challenge and runs its
 * script, the second gets the real page — the same two-step any first-time
 * visitor makes. HEADED because `--headless=new` is detected and never clears.
 * A throwaway profile keeps it away from the user's own Chrome and its logins.
 */
export async function mintCookie(): Promise<string> {
	const chrome = findChrome();
	if (!chrome) {
		throw new Error(
			`no Chrome found for the Incapsula challenge (looked in: ${CHROME_CANDIDATES.join(", ")}). ` +
				`Set CHROME_PATH to point at it.`,
		);
	}

	const port = await freePort();
	const profile = mkdtempSync(join(tmpdir(), "ss-incap-"));
	const proc = spawn(
		chrome,
		[
			`--remote-debugging-port=${port}`,
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-features=Translate",
			// Small and out of the way: this fires on a schedule, so it should not
			// steal focus or cover what the user is doing.
			"--window-size=900,700",
			"--window-position=0,0",
		],
		{ stdio: "ignore" },
	);
	proc.on("error", () => {
		/* surfaced by the target wait below */
	});

	let browserWs: string | null = null;
	try {
		let target: any = null;
		for (let i = 0; i < 40 && !target; i++) {
			await sleep(500);
			try {
				const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
				target = list.find((t) => t.type === "page");
			} catch {
				/* not up yet */
			}
		}
		try {
			const v = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as any;
			browserWs = v?.webSocketDebuggerUrl ?? null;
		} catch {
			/* closing falls back to killing */
		}
		if (!target?.webSocketDebuggerUrl) throw new Error("Chrome did not expose a CDP target");
		const url = target.webSocketDebuggerUrl;

		/**
		 * Is this the challenge, or the shop?
		 *
		 * NOT by looking for "_Incapsula_Resource": Incapsula injects that script
		 * into the REAL page too, as a routine beacon, so testing for it reports a
		 * challenge on a page that loaded perfectly — which is precisely how this
		 * failed after it had already succeeded.
		 *
		 * The challenge is unmistakable on its own terms: ~950 bytes, no <title>,
		 * and an "Incapsula incident" line. The shop is 200KB with a real title.
		 */
		const probe = `JSON.stringify({title:document.title,len:document.documentElement.outerHTML.length,incident:/Incapsula incident|Request unsuccessful/i.test(document.documentElement.outerHTML)})`;
		let cleared = false;
		for (const pass of [1, 2, 3]) {
			await cdp(url, "Page.navigate", { url: SITE });
			await sleep(pass === 1 ? 9000 : 5000); // let the challenge script run
			const { result } = await cdp(url, "Runtime.evaluate", { expression: probe, returnByValue: true });
			const s = JSON.parse(result?.value ?? "{}");
			if (!s.incident && s.title && s.len > 20_000) {
				cleared = true;
				break;
			}
		}
		if (!cleared) throw new Error("Chrome is still being shown the Incapsula challenge");

		const { cookies } = await cdp(url, "Network.getCookies", { urls: [SITE] });
		const cookie = (cookies ?? [])
			.filter((c: any) => /incap/i.test(c.name))
			.map((c: any) => `${c.name}=${c.value}`)
			.join("; ");
		if (!cookie) throw new Error("no Incapsula cookie was set");

		storeCookie(cookie);
		console.error(`Incapsula: minted a fresh session cookie via Chrome.`);
		return cookie;
	} finally {
		await shutdown(browserWs, proc.pid, profile);
	}
}

/** True for the "served a challenge instead of upgrading" failure. */
export function looksBlocked(err: unknown): boolean {
	const m = err instanceof Error ? err.message : String(err);
	return /Unexpected server response: (200|403)/.test(m);
}
