// Options — token entry plus a live setup check, so a bad token or a missing Ingredients property is found
// HERE rather than at the moment someone tries to add an item.
const $ = (id) => document.getElementById(id);
const setMsg = (text, cls) => { const el = $("msg"); el.textContent = text; el.className = cls; };

chrome.storage.local.get(["notionToken", "anthropicKey"]).then(({ notionToken, anthropicKey }) => {
  $("token").value = notionToken || "";
  $("anthropic").value = anthropicKey || "";
});

$("save").addEventListener("click", async () => {
  const notionToken = $("token").value.trim();
  // Saved but NOT test-called: verifying it costs a real (paid) request, and it is optional anyway —
  // a wrong key shows up as "couldn't establish nutrition figures" on the next add, with the row intact.
  const anthropicKey = $("anthropic").value.trim();
  await chrome.storage.local.set({ notionToken, anthropicKey });
  setMsg("Saved — testing…", "muted");
  chrome.runtime.sendMessage({ type: "token-test" }, (res) => {
    if (chrome.runtime.lastError) return setMsg(chrome.runtime.lastError.message, "error");
    if (!res) return setMsg("No response from the background worker — reload the extension.", "error");
    if (res.error) return setMsg(res.error, "error");
    const r = res.result;
    const macros = anthropicKey
      ? "\nNutrition lookup is on."
      : "\nNo Claude API key — rows will be added without nutrition.";
    if (r.ok) return setMsg(`✓ Token works and the Ingredients DB has every property this writes.${macros}`, "ok");
    setMsg(`Problems:\n• ${r.problems.join("\n• ")}`, "error");
  });
});
