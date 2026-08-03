// Macro lookup — the BROWSER transport. Runs ONLY in the background service worker.
//
// The Node side (../src/core/macros.ts) does the same job through @anthropic-ai/sdk. This does it with
// raw fetch, because the SDK is a Node HTTP client and won't bundle into a service worker. What the two
// share is everything that decides the answer — the system prompt, the tool set, the parsing, the
// per-100g sanity gate — imported from ../src/core/macro-prompt.ts rather than copied, so a fix to the
// "raw chicken is raw" rule lands in both at once.
//
// ⚠️ Two things make this work from a browser context, and both are easy to lose:
//   1. `host_permissions` must list https://api.anthropic.com/* — without it the fetch is CORS-blocked
//      exactly as api.notion.com is (see notion-client.js).
//   2. `anthropic-dangerous-direct-browser-access: true` — the API rejects requests carrying a browser
//      Origin header (which a service worker sends: chrome-extension://<id>) unless this is set. The
//      scary name is about shipping a key to untrusted end users; here the key is one the user pasted
//      into their own extension's options page, which is the same trust level as the Notion token
//      already sitting beside it.
//
// The key is the user's ANTHROPIC_API_KEY — the same value as in the project's .env, entered once on the
// options page. Non-fatal throughout: no key, a bad key, a rate limit or a malformed answer all resolve
// null, and the row keeps its price and size without nutrition.
import {
  MACRO_MODEL,
  MACRO_SYSTEM,
  MACRO_TOOLS,
  macroUserPrompt,
  parseMacroReply,
  replyText,
} from "../src/core/macro-prompt.js";

const VERSION = "2023-06-01";

// Matches TIMEOUT_MS in ../src/core/macros.ts, and for the same measured reason: a clean lookup takes
// ~55s, but one fighting an unreadable product page ran 245s before giving up. `fetch` has no timeout of
// its own, so without this the panel could sit on "Looking up nutrition…" indefinitely — and an MV3
// worker kept alive by a doomed request is a worse outcome than no figures.
const TIMEOUT_MS = 180_000;

export async function getAnthropicKey() {
  const { anthropicKey } = await chrome.storage.local.get("anthropicKey");
  return (anthropicKey || "").trim();
}

export async function macrosConfigured() {
  return Boolean(await getAnthropicKey());
}

/**
 * The four figures for one product, or null.
 *
 * NOT retried. Unlike the Notion calls next door, this is a slow, paid request behind an explicit user
 * action: a silent second attempt would double the bill and the wait for an answer the user can simply
 * ask for again. The row is already written by the time this runs, so a null costs nothing but the
 * nutrition columns.
 */
export async function lookupMacros(q) {
  const key = await getAnthropicKey();
  if (!key) return null;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "x-api-key": key,
        "anthropic-version": VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MACRO_MODEL,
        max_tokens: 8000,
        system: MACRO_SYSTEM,
        // No temperature/top_p — Sonnet 5 rejects non-default sampling parameters.
        output_config: { effort: "medium" },
        tools: MACRO_TOOLS,
        messages: [{ role: "user", content: macroUserPrompt(q) }],
      }),
    });
  } catch (e) {
    console.error(
      e.name === "AbortError"
        ? `Macro lookup: gave up after ${TIMEOUT_MS / 1000}s.`
        : `Macro lookup: network error — ${e.message}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }

  let json;
  try {
    json = await res.json();
  } catch {
    console.error(`Macro lookup: unreadable response (HTTP ${res.status}).`);
    return null;
  }
  if (!res.ok) {
    console.error(`Macro lookup: ${res.status} — ${json?.error?.message || JSON.stringify(json)}`);
    return null;
  }

  const searches = json?.usage?.server_tool_use?.web_search_requests ?? 0;
  return parseMacroReply(replyText(json.content), searches);
}
