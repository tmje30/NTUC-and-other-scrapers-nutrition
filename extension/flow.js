// flow.js — the shared capture flow used by BOTH the popup (popup.js) and the side panel (sidepanel.js).
// popup.html and sidepanel.html share the same body element ids, so this module drives either surface via
// document.getElementById. Packaged as render(tab, alive):
//   - the POPUP calls it ONCE (alive defaults to true).
//   - the SIDE PANEL calls it AGAIN on every tab switch / navigation, so render() FULLY RESETS the UI on
//     each call (never stacks listeners on the persistent elements) and honours `alive()` — a predicate
//     that goes false when the user navigates again mid-render, so a slow previous render can't clobber
//     the new tab's fields.
//
// One capture, two ways to commit it:
//   - "Add to Ingredients"  → a NEW row.
//   - "Replace With This"   → shown beside each SIMILAR existing row; repoints that row at this product.

const $ = (id) => document.getElementById(id);

// Timeout + no-response guard so a crashed service worker gives a readable error, never a silent spin.
export const send = (msg, timeoutMs = 15000) =>
  new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => done(reject, new Error("Background worker didn't respond — reload the extension on chrome://extensions and retry.")), timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) return done(reject, new Error(chrome.runtime.lastError.message));
        if (!res) return done(reject, new Error("No response from the background worker (it may have failed to start)."));
        if (res.error) return done(reject, new Error(res.error));
        done(resolve, res.result);
      });
    } catch (e) { done(reject, e); }
  });

const setStatus = (text, cls = "muted") => { const el = $("status"); el.textContent = text; el.className = cls; };
const el = (tag, props) => Object.assign(document.createElement(tag), props);

// Listener bookkeeping. render() may run many times in the persistent side panel; handlers added to the
// PERSISTENT elements (#form submit) would stack on every re-render. Track them and detach at the top of
// the next render. Buttons created inside #similar are discarded with their innerHTML, so they need none.
let tracked = [];
function on(node, ev, fn) { node.addEventListener(ev, fn); tracked.push(() => node.removeEventListener(ev, fn)); }

function resetUi() {
  for (const off of tracked) off();
  tracked = [];
  for (const id of ["existing", "similar", "result"]) { const n = $(id); n.hidden = true; n.innerHTML = ""; }
  $("form").hidden = true;
  for (const id of ["f-name", "f-exact", "f-price", "f-size", "f-vendor"]) $(id).value = "";
  for (const id of ["f-category", "f-unit"]) {
    const s = $(id);
    while (s.lastElementChild && s.lastElementChild !== s.firstElementChild) s.removeChild(s.lastElementChild);
    s.value = "";
  }
  $("add").disabled = false;
}

/** The current form values — read at CLICK time so every edit the user made is honoured. */
const formFields = (tab) => ({
  name: $("f-name").value.trim(),
  exactName: $("f-exact").value.trim(),
  priceText: $("f-price").value.trim(),
  sizeText: $("f-size").value.trim(),
  category: $("f-category").value,
  unitType: $("f-unit").value,
  vendor: $("f-vendor").value.trim(),
  url: tab.url,
});

function showRow(container, row, headline) {
  container.hidden = false;
  container.append(el("div", { textContent: headline }));
  container.append(el("strong", { textContent: row.name || "(unnamed row)" }));
  const bits = [row.exactName, row.vendor, row.price != null ? `$${row.price}` : "", row.size != null ? `${row.size} ${row.unitType || ""}`.trim() : ""].filter(Boolean);
  if (bits.length) container.append(el("div", { className: "muted", textContent: bits.join(" · ") }));
  container.append(el("a", { href: row.notionUrl, target: "_blank", textContent: "Open in Notion →" }));
}

function showExisting(existing) {
  const n = $("existing");
  n.innerHTML = "";
  showRow(n, existing, "Already added from this exact page — nothing to do.");
}

function finish(message, notionUrl) {
  $("form").hidden = true;
  $("similar").hidden = true;
  const r = $("result");
  r.hidden = false;
  r.innerHTML = "";
  r.append(el("div", { textContent: message }));
  if (notionUrl) r.append(el("a", { href: notionUrl, target: "_blank", textContent: "Open in Notion →" }));
}

/**
 * One card per ingredient row this product might already BE, each with its own "Replace With This".
 *
 * Never auto-written and never pre-selected: the target is an existing row the user maintains by hand, and
 * a fuzzy name match is exactly the kind of thing that is right most of the time and quietly wrong the rest.
 * The "Add to Ingredients" form stays visible below, so a bad suggestion costs nothing.
 */
function showSimilar(items, tab) {
  const box = $("similar");
  box.hidden = false;
  box.innerHTML = "";
  box.append(el("div", { textContent: `${items.length} similar ingredient${items.length === 1 ? "" : "s"} already in Notion:` }));

  for (const row of items) {
    const card = el("div", { className: "sim" });
    card.append(el("strong", { textContent: row.name }));
    const detail = [
      row.vendor || "no vendor",
      row.price != null ? `$${row.price}` : "no price",
      row.size != null ? `${row.size}${row.unitType ? ` (${row.unitType})` : ""}` : "no size",
    ].join(" · ");
    card.append(el("div", { className: "muted", textContent: detail }));
    if (row.exactName) card.append(el("div", { className: "muted", textContent: row.exactName }));
    card.append(el("a", { href: row.notionUrl, target: "_blank", textContent: "Open in Notion →" }));

    const btn = el("button", { type: "button", className: "secondary", textContent: "Replace With This" });
    card.append(btn);
    btn.addEventListener("click", async () => {
      const fields = formFields(tab);
      if (!fields.name) return setStatus("Give it a name first.", "error");
      // Replacing overwrites a row the user curates by hand, and there is no undo — so it asks, naming both
      // sides. Everything not listed (nutrition, plan formulas, tags) is left untouched.
      const ok = confirm(
        `Replace "${row.name}" with this product?\n\n` +
        `  Name            ${row.name}  →  ${fields.name}\n` +
        `  Items Exact Name  →  ${fields.exactName || "(blank)"}\n` +
        `  Price,SGD       ${row.price ?? "—"}  →  ${fields.priceText || "(unchanged)"}\n` +
        `  Weight /Units   ${row.size ?? "—"}  →  ${fields.sizeText || "(unchanged)"}\n` +
        `  Vendor, Current ${row.vendor || "—"}  →  ${fields.vendor || "(unchanged)"}\n\n` +
        `Nutrition, plan formulas and tags are left alone.`
      );
      if (!ok) return;
      btn.disabled = true;
      setStatus(`Replacing "${row.name}"…`);
      try {
        const res = await send({ type: "replace-item", pageId: row.id, ...fields });
        setStatus("Replaced ✓", "ok");
        finish(`"${res.updated.before.name || row.name}" now points at this product.`, res.updated.notionUrl);
      } catch (err) {
        setStatus(err.message, "error");
        btn.disabled = false;
      }
    });
    box.append(card);
  }
}

/** Fill a <select> with live Notion options and pre-select `chosen` when it is one of them. */
function fillSelect(id, options, chosen) {
  const s = $(id);
  for (const o of options) s.append(el("option", { value: o, textContent: o }));
  if (chosen && options.includes(chosen)) s.value = chosen;
}

// Read the current page. The reader (dist/content.js) is injected ON DEMAND. In the POPUP the injection is
// granted by `activeTab` (the click that opened it). In the SIDE PANEL there is no per-open activeTab grant
// for tabs the user navigates to, so extraction works only once the optional host permission is granted via
// the panel's banner — otherwise this returns null and the fields are simply blank and manual.
async function extractFromTab(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["dist/content.js"] });
  } catch { return null; }
  try {
    return await new Promise((resolve, reject) =>
      chrome.tabs.sendMessage(tabId, { type: "extract" }, (res) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(res);
      }));
  } catch { return null; }
}

/** The whole flow for one tab. Re-entrant: safe to call repeatedly (the side panel does). */
export async function render(tab, alive = () => true) {
  resetUi();
  if (!tab?.url || !/^https?:/.test(tab.url)) return setStatus("Open a product page first.", "muted");

  setStatus("Checking setup…");
  const setup = await send({ type: "setup-check", url: tab.url });
  if (!alive()) return;
  if (!setup.ok) {
    return setStatus(`Can't write to Ingredients yet:\n• ${(setup.problems || ["unknown setup problem"]).join("\n• ")}`, "error");
  }

  setStatus(`${setup.vendor} — checking whether this page is already added…`);
  const dup = await send({ type: "check-url", url: tab.url });
  if (!alive()) return;
  if (dup.found) { setStatus("Already added.", "ok"); return showExisting(dup.existing); }

  const extracted = await extractFromTab(tab.id);
  if (!alive()) return;
  if (!extracted) {
    setStatus("⚠️ Couldn't read this page — type the fields in below.", "error");
  }
  const data = extracted || { name: "", brand: "", priceText: "", sizeText: "" };

  // Generic Name / exact name / category / size — derived in the worker so the popup and side panel can't
  // drift apart. Non-fatal: a failure just leaves the derived boxes blank for the user to fill.
  let derived = { generic: "", exactName: "", category: "", size: null, unitType: "" };
  try {
    derived = await send({ type: "derive", name: data.name, brand: data.brand, sizeText: data.sizeText });
  } catch { /* fall through with blanks */ }
  if (!alive()) return;

  $("f-name").value = derived.generic || data.name || "";
  $("f-exact").value = derived.exactName || data.name || "";
  $("f-price").value = data.priceText || "";
  $("f-size").value = derived.size != null ? String(derived.size) : (data.sizeText || "");
  $("f-vendor").value = setup.vendor || "";

  let options = { categories: [], unitTypes: [] };
  try { options = await send({ type: "field-options" }); } catch { /* dropdowns stay empty */ }
  if (!alive()) return;
  fillSelect("f-category", options.categories || [], derived.category);
  fillSelect("f-unit", options.unitTypes || [], derived.unitType);

  $("form").hidden = false;
  if (extracted) {
    setStatus(setup.known
      ? `${setup.vendor} — check the fields, then add.`
      : `${setup.host} isn't a shop I know — check the vendor name too.`, "muted");
  }

  // Similar existing rows → a "Replace With This" beside each. Non-blocking: the add form is already up, so
  // a slow or failed lookup never stops a normal add.
  const nameForMatch = $("f-name").value;
  if (nameForMatch.trim()) {
    send({ type: "find-similar", name: nameForMatch })
      .then((res) => { if (alive() && res.items?.length) showSimilar(res.items, tab); })
      .catch(() => {});
  }

  on($("form"), "submit", async (e) => {
    e.preventDefault();
    const fields = formFields(tab);
    if (!fields.name) return setStatus("Give it a name first.", "error");
    $("add").disabled = true;
    setStatus("Adding to Ingredients…");
    try {
      const res = await send({ type: "add-item", ...fields });
      if (res.duplicate) { setStatus("Already added from this page.", "ok"); $("form").hidden = true; return showExisting(res.duplicate); }
      setStatus("Added ✓", "ok");
      finish(`Added "${fields.name}" to Ingredients.`, res.created.notionUrl);
    } catch (err) {
      setStatus(err.message, "error");
      $("add").disabled = false;
    }
  });
}
