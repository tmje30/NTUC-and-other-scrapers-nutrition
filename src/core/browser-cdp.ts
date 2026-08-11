/**
 * Drive the installed Chrome over CDP and evaluate JavaScript in a page.
 *
 * This is the generic version of what `incapsula.ts` does for one site. That module
 * exists to *mint a cookie* for Sheng Siong and then get out of the way; this one is
 * for shops whose content simply cannot be read without a browser at all:
 *
 *   - **rendering walls** — Guardian serves an identical 136,929-byte SPA shell for every
 *     URL, so there is nothing in the HTML to parse. No anti-bot, just no content.
 *   - **anti-bot walls** — Carousell's search refuses a bare fetch (Cloudflare) but renders
 *     normally in a real browser.
 *   - **auth walls** — Shopee redirects every anonymous request to
 *     `/verify/traffic/error?…&is_logged_in=false` ("Login Required"). Only a signed-in
 *     session gets through, which is what `persistProfile` is for.
 *
 * ⚠️ **This module never enters credentials.** For an auth-walled shop the user signs in
 * once, by hand, in the window this opens; the profile directory keeps that session for
 * later runs. Automating a login is out of scope on purpose — see the project rules.
 *
 * The three CDP traps from LEARNINGS (all hit in one evening on the Incapsula work) are
 * avoided here in the same ways:
 *   - the debug port is **never hardcoded** — a leftover Chrome would still hold it and
 *     `/json/list` would answer from the *stale* browser, so you would drive a window you
 *     never navigated;
 *   - killing the spawned pid does **not** kill Chrome (it re-parents), so we close over
 *     CDP first, then kill the tree, then sweep by the launch's own profile path;
 *   - a failure is remembered by the caller, never retried in a loop — one failing launch
 *     retried per search term is how 42 stray Chrome processes happened.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { findChrome } from "./stores/incapsula.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A free TCP port, asked of the OS rather than guessed. See the trap note above. */
function freePort(): Promise<number> {
	return new Promise((res, rej) => {
		const srv = createServer();
		srv.on("error", rej);
		srv.listen(0, "127.0.0.1", () => {
			const port = (srv.address() as { port: number }).port;
			srv.close(() => res(port));
		});
	});
}

/** One CDP command on a socket, with its own timeout. */
function send(url: string, method: string, params: unknown = {}, timeoutMs = 45_000): Promise<any> {
	return new Promise((resolve_, reject) => {
		const ws = new WebSocket(url);
		const t = setTimeout(() => {
			ws.close();
			reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
		ws.on("message", (raw: WebSocket.RawData) => {
			const d = JSON.parse(raw.toString());
			if (d.id !== 1) return;
			clearTimeout(t);
			ws.close();
			d.error ? reject(new Error(`CDP ${method}: ${d.error.message}`)) : resolve_(d.result);
		});
		ws.on("error", (e: Error) => {
			clearTimeout(t);
			reject(e);
		});
	});
}

async function httpJson(url: string): Promise<any> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
	return res.json();
}

export interface BrowserOptions {
	/**
	 * Keep the Chrome profile at this path instead of a throwaway temp dir, so a login
	 * survives between runs. Required for Shopee; pointless for Carousell and Guardian.
	 * Put it under `.sessions/` — that directory is gitignored precisely because what
	 * lands in it is a session credential.
	 */
	persistProfile?: string;
	/** Show the window. Headless is DETECTED by several of these sites — see incapsula.ts. */
	headed?: boolean;
	/** Milliseconds to let client-side rendering settle after load. */
	settleMs?: number;
	/**
	 * A JS expression polled until it returns truthy — read the page the moment it is
	 * ready instead of guessing how long it takes.
	 *
	 * ⚠️ **Some of these shops render, then WIPE.** Watsons was measured on 2026-08-11
	 * rendering 52 prices and 96 product links at 7–16 s, and **484 B of nothing at 22 s**:
	 * a bot check tears the results down after the fact. A fixed `settleMs` therefore has
	 * to thread a window with a failure at BOTH ends — too early is an empty shell, too
	 * late is an empty shell, and the two are indistinguishable in the output. That is
	 * exactly how this shop collected two independent "dead end, the product API never
	 * yields" verdicts while working the whole time.
	 *
	 * Polling removes the guess: as soon as products exist the page is read, so the wipe
	 * is never reached. `settleMs` becomes the give-up deadline rather than the plan.
	 */
	waitFor?: string;
	/** How often to test `waitFor`. */
	pollMs?: number;
}

export interface PageResult {
	/** Where we ended up — a redirect to a login/verify page is the interesting case. */
	url: string;
	title: string;
	/** Whatever the caller's expression returned, JSON round-tripped. */
	value: unknown;
}

/**
 * Open `url` in a real Chrome and evaluate `expression` in the page.
 *
 * `expression` is a STRING evaluated in the page context — it closes over nothing from
 * here, exactly like the `world: "MAIN"` injection in the Chrome extension. Return a
 * JSON-serialisable value from it.
 */
export async function evaluateInPage(
	url: string,
	expression: string,
	opts: BrowserOptions = {},
): Promise<PageResult> {
	const chrome = findChrome();
	if (!chrome) throw new Error("no Chrome found (set CHROME_PATH)");

	const port = await freePort();
	let profile: string;
	if (opts.persistProfile) {
		profile = resolve(opts.persistProfile);
		if (!existsSync(profile)) mkdirSync(profile, { recursive: true });
	} else {
		profile = mkdtempSync(join(tmpdir(), "probe-"));
	}

	const args = [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profile}`,
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-features=Translate",
		"--window-size=1280,900",
		"--window-position=0,0",
	];
	if (!opts.headed) args.push("--headless=new");

	let proc: ChildProcess | undefined;
	let browserWs: string | null = null;
	try {
		proc = spawn(chrome, args, { stdio: "ignore", detached: false });

		// Poll for the debugger rather than sleeping a fixed time — a cold profile is slow.
		let version: any = null;
		for (let i = 0; i < 60; i++) {
			try {
				version = await httpJson(`http://127.0.0.1:${port}/json/version`);
				break;
			} catch {
				await sleep(250);
			}
		}
		if (!version) throw new Error("Chrome never opened its debugger port");
		browserWs = version.webSocketDebuggerUrl ?? null;

		const target = await send(browserWs!, "Target.createTarget", { url: "about:blank" });
		const targets: any[] = await httpJson(`http://127.0.0.1:${port}/json/list`);
		const page = targets.find((t) => t.id === target.targetId);
		if (!page?.webSocketDebuggerUrl) throw new Error("could not attach to the new tab");
		const ws = page.webSocketDebuggerUrl;

		await send(ws, "Page.enable");
		await send(ws, "Page.navigate", { url });

		const read = async (expr: string) =>
			(await send(ws, "Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
				?.result?.value;

		const deadline = opts.settleMs ?? 6000;
		if (opts.waitFor) {
			// Poll to the deadline, then read regardless — a timeout still returns whatever
			// is on the page, because "we waited and it never appeared" is a RESULT the
			// caller needs to see and diagnose, not an exception to swallow.
			const poll = opts.pollMs ?? 500;
			const until = Date.now() + deadline;
			while (Date.now() < until) {
				try {
					if (await read(opts.waitFor)) break;
				} catch {
					// A page mid-navigation throws; that is not a failure, just "not yet".
				}
				await sleep(poll);
			}
		} else {
			await sleep(deadline);
		}

		return {
			url: String(await read("location.href")),
			title: String(await read("document.title")),
			value: await read(expression),
		};
	} finally {
		// Close over CDP FIRST — killing the pid alone leaves a re-parented browser running.
		try {
			if (browserWs) await send(browserWs, "Browser.close", {}, 8000);
		} catch {
			/* already gone */
		}
		try {
			proc?.kill();
		} catch {
			/* already gone */
		}
	}
}
