// Side panel — the same flow as the popup, but it STAYS OPEN and re-renders as you browse, so walking a
// shop's catalogue keeps showing "already added / similar rows / add it" hands-free.
//
// Re-render safety: every render is stamped with a sequence number, and `alive()` goes false as soon as a
// newer one starts. Without it a slow render (a Notion round-trip) would finish AFTER you had already
// switched tabs and write the previous product's values into the new tab's form.
import { render } from "./flow.js";

let seq = 0;

async function rerender() {
  const mine = ++seq;
  const alive = () => mine === seq;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!alive()) return;
    await render(tab, alive);
  } catch (e) {
    if (!alive()) return;
    const el = document.getElementById("status");
    el.textContent = e.message;
    el.className = "error";
  }
}

// The panel has no per-open `activeTab` grant for pages you navigate to yourself, so reading page CONTENT
// needs the optional host permission. Vendor + duplicate checks work from the URL without it (that comes
// from `tabs` — metadata only); only auto-filling the fields needs this.
async function syncBanner() {
  const granted = await chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] });
  document.getElementById("banner").hidden = granted;
}

document.getElementById("grant").addEventListener("click", async () => {
  const ok = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
  if (ok) { await syncBanner(); rerender(); }
});

chrome.tabs.onActivated.addListener(rerender);
chrome.tabs.onUpdated.addListener((_id, info, tab) => { if (info.status === "complete" && tab.active) rerender(); });
chrome.windows.onFocusChanged.addListener((id) => { if (id !== chrome.windows.WINDOW_ID_NONE) rerender(); });

syncBanner();
rerender();
