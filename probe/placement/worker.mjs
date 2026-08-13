/**
 * Can an unattended Cloudflare job be pinned to Singapore?
 *
 * Tonight's probe proved a Worker in the SIN colo talks to Sheng Siong happily.
 * That only covers requests that arrive FROM Singapore — i.e. a tap on the page.
 * A cron trigger has no incoming request, so Cloudflare places it wherever it
 * likes, and the one variable that decides whether Sheng Siong answers is which
 * country the code runs in.
 *
 * Durable Objects are the only placement control on offer, and the hint is
 * region-coarse: `apac` covers Tokyo, Sydney, Hong Kong, Seoul and Singapore
 * alike. So the question is empirical, and in two parts:
 *
 *   1. Ask for `apac` several times — does SIN ever come up, and how often?
 *   2. When it does, is it STUCK there? A DO that drifts is worse than useless
 *      here: it would work for days and then quietly stop, which is the exact
 *      failure this system has been bitten by twice already.
 *
 * ⚠️ The colo is read by having the DO itself fetch `cdn-cgi/trace`, not from
 * `request.cf`. What matters is where the DO's own outbound request leaves from
 * — that is the address Sheng Siong will judge — and only the DO can report it.
 *
 *   npx wrangler dev --remote          then hit /?tries=8
 *                                      and /?id=<name> to re-check stickiness
 */

async function whereAmI() {
	const res = await fetch("https://cloudflare.com/cdn-cgi/trace", { headers: { "cache-control": "no-cache" } });
	const t = Object.fromEntries(
		(await res.text())
			.trim()
			.split("\n")
			.map((l) => l.split("="))
			.filter(([k]) => ["ip", "loc", "colo"].includes(k)),
	);
	return t;
}

export class Placement {
	constructor(state) {
		this.state = state;
	}

	async fetch() {
		const now = await whereAmI();
		// Recorded on first contact, so a later call can prove whether this object
		// has moved since it was created.
		let first = await this.state.storage.get("first");
		if (!first) {
			first = { ...now, at: new Date().toISOString() };
			await this.state.storage.put("first", first);
		}
		const calls = ((await this.state.storage.get("calls")) ?? 0) + 1;
		await this.state.storage.put("calls", calls);
		return Response.json({ colo: now.colo, loc: now.loc, ip: now.ip, firstColo: first.colo, firstLoc: first.loc, calls });
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const hint = url.searchParams.get("hint") || "apac";

		// Re-check one object by name: has it stayed where it was created?
		const existing = url.searchParams.get("id");
		if (existing) {
			const stub = env.PLACEMENT.get(env.PLACEMENT.idFromName(existing), { locationHint: hint });
			const now = await (await stub.fetch("https://placement/")).json();
			return Response.json({
				mode: "recheck",
				name: existing,
				...now,
				stuck: now.colo === now.firstColo,
			});
		}

		const tries = Math.min(Number(url.searchParams.get("tries") || 6), 20);
		const results = [];
		for (let i = 0; i < tries; i++) {
			// A fresh name each run: an id that already exists would return its old
			// home and tell us nothing about placement.
			const name = `place-${Date.now().toString(36)}-${i}`;
			try {
				const stub = env.PLACEMENT.get(env.PLACEMENT.idFromName(name), { locationHint: hint });
				const r = await (await stub.fetch("https://placement/")).json();
				results.push({ name, colo: r.colo, loc: r.loc });
			} catch (e) {
				results.push({ name, error: String(e.message ?? e) });
			}
		}

		const counts = {};
		for (const r of results) counts[r.colo ?? "error"] = (counts[r.colo ?? "error"] ?? 0) + 1;
		const sg = results.filter((r) => r.loc === "SG");
		const failed = results.filter((r) => r.error);

		// ⚠️ An attempt that ERRORED is not an attempt that landed outside Singapore,
		// and the difference decides whether the laptop can be retired. The first run
		// of this probe returned `NO SG — "apac" never placed in Singapore` when in
		// fact all eight calls had failed before placing anything (`wrangler dev
		// --remote` has dropped Durable Object support). A probe that reports a clean
		// negative from a broken run is worse than one that reports nothing.
		if (failed.length === results.length) {
			return Response.json(
				{
					mode: "placement",
					hint,
					tries,
					verdict: "INCONCLUSIVE — every attempt errored; nothing was placed",
					error: failed[0].error,
					results,
				},
				{ status: 503, headers: { "cache-control": "no-store" } },
			);
		}

		// If we landed in Singapore even once, immediately ask that same object
		// again — a hit that does not hold is not a result worth acting on.
		let recheck = null;
		if (sg.length) {
			const stub = env.PLACEMENT.get(env.PLACEMENT.idFromName(sg[0].name), { locationHint: hint });
			const r = await (await stub.fetch("https://placement/")).json();
			recheck = { name: sg[0].name, colo: r.colo, firstColo: r.firstColo, stuck: r.colo === r.firstColo, calls: r.calls };
		}

		return Response.json(
			{
				mode: "placement",
				hint,
				tries,
				counts,
				singapore: sg.length,
				failed: failed.length,
				verdict: sg.length
					? recheck?.stuck
						? "PASS — landed in Singapore and stayed there"
						: "UNSTABLE — landed in Singapore but moved on the next call"
					: `NO SG — "${hint}" never placed in Singapore across ${tries - failed.length} successful tries`,
				recheck,
				results,
			},
			{ headers: { "cache-control": "no-store" } },
		);
	},
};
