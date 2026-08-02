// Popup — a thin caller of the shared capture flow (flow.js), which popup.html and sidepanel.html both
// drive (identical body ids). The popup runs the flow ONCE for the current tab; the side panel re-runs the
// same flow as you browse.
import { render } from "./flow.js";

const setStatus = (text, cls = "error") => { const el = document.getElementById("status"); el.textContent = text; el.className = cls; };

// Captured at load so the "Open side panel" button can call sidePanel.open() SYNCHRONOUSLY inside the click
// handler — an await before open() would spend the user gesture the API requires.
let activeTab = null;

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  await render(tab);
}

const spBtn = document.getElementById("open-sidepanel");
if (spBtn) {
  spBtn.addEventListener("click", () => {
    if (!activeTab) return;
    chrome.sidePanel.open({ windowId: activeTab.windowId }).then(() => window.close()).catch(() => {});
  });
}

main().catch((e) => setStatus(e.message));
