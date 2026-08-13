/**
 * The Worker's way of writing to the repo.
 *
 * The laptop runner commits with the git CLI (`commitAndPushData`, which pulls
 * and retries when the push is rejected for being behind). A Worker has no git
 * and no filesystem, so it uses the Contents API: read the file's blob sha, PUT
 * the new content against that sha.
 *
 * ⚠️ **The sha IS the concurrency control**, and it replaces the pull-and-retry
 * the CLI path needs. GitHub rejects a PUT whose `sha` is not the file's current
 * one with a `409`, so a scan racing anything else that touched the file loses
 * loudly instead of overwriting it. `commitScanFile` retries once on a 409 by
 * re-reading the sha — the file is regenerated in full every run, so there is
 * nothing to merge and last-writer-wins is correct here.
 *
 * ⚠️ **The token is a fine-grained PAT with Contents: read and write on this repo
 * and nothing else** — the same shape the relay uses. That is exactly what a
 * commit plus a `repository_dispatch` needs; Administration does not grant it and
 * is not required.
 */

const API = "https://api.github.com";

function headers(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		// GitHub rejects API requests with no User-Agent.
		"User-Agent": "ss-worker",
	};
}

/**
 * UTF-8 → base64, in chunks.
 *
 * ⚠️ `btoa(String.fromCharCode(...bytes))` is the obvious one-liner and it breaks
 * on this input: spreading a ~230 KB array into a call blows the argument limit.
 * The scan file is ~230 KB today and grows with the term list, so this walks it.
 */
export function toBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

async function currentSha(repo: string, path: string, token: string): Promise<string | undefined> {
	const res = await fetch(`${API}/repos/${repo}/contents/${path}`, { headers: headers(token) });
	// 404 is a legitimate first write, not an error.
	if (res.status === 404) return undefined;
	if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status} ${await res.text().catch(() => "")}`);
	const body: any = await res.json();
	return typeof body?.sha === "string" ? body.sha : undefined;
}

export async function commitScanFile(opts: {
	repo: string;
	path: string;
	token: string;
	content: string;
	message: string;
}): Promise<{ commit: string }> {
	const { repo, path, token, content, message } = opts;
	const encoded = toBase64(content);

	for (let attempt = 0; attempt < 2; attempt++) {
		const sha = await currentSha(repo, path, token);
		const res = await fetch(`${API}/repos/${repo}/contents/${path}`, {
			method: "PUT",
			headers: { ...headers(token), "Content-Type": "application/json" },
			body: JSON.stringify({ message, content: encoded, ...(sha ? { sha } : {}) }),
		});
		if (res.ok) {
			const body: any = await res.json();
			return { commit: body?.commit?.sha ?? "?" };
		}
		// Someone else moved the file between the read and the write. Re-read once.
		if (res.status === 409 && attempt === 0) continue;
		throw new Error(`GitHub PUT ${path}: ${res.status} ${await res.text().catch(() => "")}`);
	}
	throw new Error(`GitHub PUT ${path}: lost the sha race twice`);
}

/**
 * Ask Actions to rebuild the page.
 *
 * ⚠️ Fired ONLY after a successful commit. Dispatching on a scan that never
 * landed rebuilds the page from the same old file and clears the warning's cause
 * without fixing it — the user taps Rescan and gets their stale page back, which
 * is precisely the bug this whole path exists to fix (`ss-on-request.ts:74`).
 */
export async function dispatchRebuild(repo: string, token: string, eventType = "rescan"): Promise<void> {
	const res = await fetch(`${API}/repos/${repo}/dispatches`, {
		method: "POST",
		headers: { ...headers(token), "Content-Type": "application/json" },
		body: JSON.stringify({ event_type: eventType }),
	});
	if (!res.ok) throw new Error(`GitHub dispatch ${eventType}: ${res.status} ${await res.text().catch(() => "")}`);
}

/** Read the committed scan file, to answer "did today's scan already land?". */
export async function readScanFile(repo: string, path: string, token: string): Promise<any | null> {
	const res = await fetch(`${API}/repos/${repo}/contents/${path}`, {
		headers: { ...headers(token), Accept: "application/vnd.github.raw" },
	});
	if (!res.ok) return null;
	try {
		return JSON.parse(await res.text());
	} catch {
		return null;
	}
}
