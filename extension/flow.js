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

// Imported, not reimplemented: which pack shots get attached is a decision with a price on it, and the
// panel must not describe a gate different from the one the worker actually applies. esbuild bundles
// flow.js into popup.js and sidepanel.js, so src/core is reachable from here exactly as it is from
// background.js. `categorize` comes along because `packShotsFor` needs the same `categoryKey` the worker
// derives — a fresh commodity is refused its photos, and the panel must say so too.
import { packShotsFor } from "../src/core/macro-prompt.js";
import { categorize } from "../src/core/categorize.js";

/** The bit of the worker's MacroQuery that decides whether pack shots are attached. Kept in step with `macros-for`. */
const shotQuery = (name, exactName, images) => ({
  product: exactName || name || "",
  ingredientName: name || "",
  categoryKey: categorize(name || exactName || "") || undefined,
  images: images || [],
});

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
  for (const id of ["f-name", "f-exact", "f-price", "f-size", "f-vendor", "f-protein", "f-carbs", "f-fats", "f-fiber"]) {
    $(id).value = "";
  }
  // The side panel re-renders on every navigation, so the previous product's panel note and its
  // "read off the label" highlight must not carry over onto the next one.
  $("f-macro-note").textContent = "";
  $("f-macro-note").className = "muted";
  document.querySelector(".macros")?.classList.remove("from-page");
  // Hidden by default and re-shown per page in render(): the side panel re-renders on every navigation,
  // and a Find Macros left over from the last product would look the current one up.
  const fm = $("find-macros");
  fm.hidden = true;
  fm.disabled = false;
  fm.textContent = "Find Macros";
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
  // Per 100g. Sent as typed and parsed in the worker, like price and size — the four boxes are editable,
  // so a figure corrected by hand must be the one that gets written.
  protein: $("f-protein").value.trim(),
  carbs: $("f-carbs").value.trim(),
  fats: $("f-fats").value.trim(),
  fiber: $("f-fiber").value.trim(),
});

/**
 * Show the four figures the shop's own panel gave, ready to be edited or cleared.
 *
 * Filling these in is what stops the paid lookup from running at all — the page already answered, so
 * spending 3 to 29 cents and up to 30 seconds asking a model the same question would be daft. Marked green and
 * captioned with the serving it was scaled from, because "per 32 g serving, scaled to 100 g" is the one
 * fact that says whether to trust the number: getting the serving wrong is the classic way a nutrition
 * panel gets misread, and the user can check it against the packet in about a second.
 */
function fillMacrosFromPanel(panel) {
  const set = (id, v) => { $(id).value = typeof v === "number" ? String(v) : ""; };
  set("f-protein", panel.proteinPer100g);
  set("f-carbs", panel.carbsPer100g);
  set("f-fats", panel.fatsPer100g);
  set("f-fiber", panel.fiberPer100g);
  const note = $("f-macro-note");
  note.className = "ok";
  note.textContent = `✓ ${panel.basis}`;
  document.querySelector(".macros")?.classList.add("from-page");
}

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
  return r;
}

/**
 * "Find Macros" — the ONLY road to a paid nutrition lookup in this extension.
 *
 * ⚠️ It fills the BOXES; it does not write to Notion. That ordering is the whole point (changed
 * 2026-08-04). Adding a row used to fire this automatically whenever the boxes were empty, so an ordinary
 * Add could quietly spend up to 29 cents on a lookup nobody asked for and nobody read. Now the figures
 * arrive in four editable boxes, the user reads them — the SOURCE line especially — and only then presses
 * Add, which writes them with the row for free.
 *
 * The button only exists when it would do something: the page published no panel, and a key is set.
 * Where the shop published a panel the boxes are already filled and greened, and pressing anything would
 * be paying for an answer we have.
 */
async function findMacros(fields) {
  const btn = $("find-macros");
  const note = $("f-macro-note");
  // The wait is wildly different depending on whether the shop photographed the back of the pack: ~5s
  // reading a label off a photo, 10-30s sending the model to find one. Say which, so a long wait doesn't
  // look like a hang.
  const shots = packShotsFor(shotQuery(fields.name, fields.exactName, fields.images));
  btn.disabled = true;
  btn.textContent = "Looking up…";
  note.className = "muted";
  note.textContent = shots.length
    ? `Reading the panel off the pack photo${shots.length === 1 ? "" : "s"} (a few seconds)…`
    : "Looking up nutrition (10–30s)…";

  let res;
  try {
    // 200s: past the worker's own 180s ceiling, so the timeout that reports is the one that actually
    // knows why it gave up.
    res = await send({ type: "find-macros", ...fields }, 200000);
  } catch (err) {
    note.textContent = `Lookup failed — ${err.message} Type the figures in by hand, or try again.`;
    btn.disabled = false;
    btn.textContent = "Find Macros";
    return;
  }

  if (!res.ok) {
    note.textContent =
      res.reason === "no-key"
        ? "No Claude API key set — add one on the Options page, or type the figures in."
        : "Couldn't establish figures for this one — type them in by hand.";
    btn.disabled = false;
    btn.textContent = "Find Macros";
    return;
  }

  const m = res.macros;
  const set = (id, v) => { $(id).value = typeof v === "number" ? String(v) : ""; };
  set("f-protein", m.proteinPer100g);
  set("f-carbs", m.carbsPer100g);
  set("f-fats", m.fatsPer100g);
  set("f-fiber", m.fiberPer100g);
  // Generic values are a category average rather than this product's label, so they stay grey and say so.
  // Everything else came off a real panel and is greened like the free path.
  note.className = m.source === "generic" ? "muted" : "ok";
  note.textContent =
    (m.source === "generic" ? "⚠️ Generic values, not this product's own label — check them. " : "✓ ") +
    m.note;
  if (m.source !== "generic") document.querySelector(".macros")?.classList.add("from-page");
  // Left enabled: the figures are a proposal, and asking again is the user's call.
  btn.disabled = false;
  btn.textContent = "Find again";
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

/**
 * Ask a Meteor shop's OWN app for the product — Sheng Siong.
 *
 * Sheng Siong publishes nothing a scraper can read: no JSON-LD, no product meta tags, no server-rendered
 * data, not even an <h1>, and a site-wide <title>. Everything arrives over its DDP socket after hydration.
 * But the page already holds an open, Incapsula-cleared connection, so the cheapest reliable route is to
 * ask it, with the same method the daily scraper uses — `Products.getOneByIdOrSlug`. That returns the
 * authoritative record including a NUMERIC `netWeight`, which is better than anything the DOM could give.
 *
 * This has to live here rather than in content.js because a content script runs in an ISOLATED world and
 * cannot see the page's `window.Meteor`; `world: "MAIN"` is the supported way in.
 *
 * `func` is serialised and runs in the page, so it must close over NOTHING. Self-guarding: a page without
 * Meteor, or one whose record doesn't match the slug in the address bar, resolves null and the normal
 * extraction stands.
 */
async function extractViaMeteor(tabId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () =>
        new Promise((resolve) => {
          const slug = decodeURIComponent((location.pathname.split("/product/")[1] || "")).replace(/\/+$/, "");
          const m = window.Meteor;
          if (!slug || !m || typeof m.call !== "function") return resolve(null);
          let settled = false;
          const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
          setTimeout(() => finish(null), 6000); // never hang the panel on a dead socket
          try {
            m.call("Products.getOneByIdOrSlug", slug, null, { slug: "" }, (err, p) => {
              if (err || !p || (p.slug && p.slug !== slug)) return finish(null);
              finish({
                name: String(p.name || ""),
                brand: String(p.brand || ""),
                price: typeof p.price === "number" ? p.price : null,
                packSize: String(p.packSize || ""),
                netWeight: typeof p.netWeight === "number" ? p.netWeight : null,
              });
            });
          } catch { finish(null); }
        }),
    });
    const p = res?.result;
    if (!p || !p.name) return null;
    // Size: prefer the numeric `netWeight` over the printed `packSize` ("6 x 10 g"), which a parser has to
    // interpret. But netWeight is ALWAYS in grams, so the UNIT has to come from packSize or a 12 x 1 L
    // carton of milk is filed as 12000 By Gram instead of By ml. Three cases, decided by what packSize says:
    //   volume ("12 x 1 L")  -> "<netWeight> ml"  (the project treats ml ≈ g, so the number carries over)
    //   weight ("6 x 10 g")  -> "<netWeight> g"
    //   a bare count ("10 s") -> packSize itself, so eggs and tea bags stay By Unit
    const hasVolume = /\b(ml|cl|dl|l|ltr|litre|liter)\b/i.test(p.packSize);
    const hasWeight = /\b(g|gm|gms|gram|grams|kg|kgs)\b/i.test(p.packSize);
    const weighed = p.netWeight != null && p.netWeight > 0;
    const sizeText = weighed && hasVolume ? `${p.netWeight} ml`
      : weighed && (hasWeight || !p.packSize) ? `${p.netWeight} g`
      : p.packSize || (weighed ? `${p.netWeight} g` : "");

    return {
      name: p.name,
      brand: p.brand,
      priceText: p.price != null ? String(Math.round(p.price * 100) / 100) : "",
      sizeText,
    };
  } catch {
    return null; // no permission / not a Meteor page / injection refused
  }
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

  // A Meteor shop's own record beats anything scraped off its DOM, so it wins where it answers. Returns
  // null on every non-Meteor page, which is why it can run unconditionally rather than behind a host list.
  const viaApp = await extractViaMeteor(tab.id);
  if (!alive()) return;

  if (!extracted && !viaApp) {
    setStatus("⚠️ Couldn't read this page — type the fields in below.", "error");
  }
  // ⚠️ Spread order matters and `viaApp` must not blank a field it doesn't carry: the Meteor reader returns
  // name/brand/price/size only, so `images` and `nutritionHtml` survive from `extracted`. Adding a key to
  // `extractViaMeteor`'s return that it can't actually fill would silently wipe the FairPrice one.
  const data = { ...(extracted || { name: "", brand: "", priceText: "", sizeText: "" }), ...(viaApp || {}) };

  // Generic Name / exact name / category / size — derived in the worker so the popup and side panel can't
  // drift apart. Non-fatal: a failure just leaves the derived boxes blank for the user to fill.
  let derived = { generic: "", exactName: "", category: "", size: null, unitType: "", panel: null };
  try {
    derived = await send({
      type: "derive",
      name: data.name,
      brand: data.brand,
      sizeText: data.sizeText,
      nutritionHtml: data.nutritionHtml,
    });
  } catch { /* fall through with blanks */ }
  if (!alive()) return;

  $("f-name").value = derived.generic || data.name || "";
  $("f-exact").value = derived.exactName || data.name || "";
  $("f-price").value = data.priceText || "";
  $("f-size").value = derived.size != null ? String(derived.size) : (data.sizeText || "");
  $("f-vendor").value = setup.vendor || "";

  // The shop's own panel, when it published one. Left blank otherwise, and then Add looks the figures up —
  // which is the common case for fresh meat and produce, where no panel exists to read.
  if (derived.panel) {
    fillMacrosFromPanel(derived.panel);
  } else if (setup.macrosConfigured) {
    // No free panel, but a key is set — so a lookup is possible and the button appears. It is the only
    // way anything here spends money; nothing runs on its own.
    const fm = $("find-macros");
    fm.hidden = false;
    on(fm, "click", () => {
      const f = formFields(tab);
      findMacros({
        name: f.name,
        exactName: f.exactName,
        vendor: f.vendor,
        url: f.url,
        category: f.category,
        // Off the page reading, not the form: the shop's back and side pack shots turn a 29-cent,
        // 54-second lookup into a 3-cent, 8-second one by letting the model read the label.
        images: data.images || [],
      });
    });
  }
  if (!derived.panel) {
    // ⚠️ These lines must never say "when you add". Nothing is looked up on Add any more, and a note
    // promising figures that then don't appear is how a user stops trusting the panel.
    $("f-macro-note").textContent = !setup.macrosConfigured
      ? "No panel on this page. Add a Claude API key in Options to look these up, or type them in."
      : packShotsFor(shotQuery(derived.generic || data.name, derived.exactName || data.name, data.images)).length
        ? "No panel on this page — Find Macros reads it off the back-of-pack photo (a few seconds)."
        : "No panel on this page — Find Macros looks it up (10–30s, and it costs money).";
  }

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
      const box = finish(`Added "${fields.name}" to Ingredients.`, res.created.notionUrl);

      // Figures that were already in the boxes went in WITH the row — nothing more to do, and nothing to
      // pay for. This is the whole point of reading the shop's panel at render time.
      if (res.macrosFromForm) {
        const w = res.created.macrosWritten || [];
        box.append(el("div", {
          className: "ok",
          textContent: w.length ? `Nutrition written: ${w.join(", ")}.` : "Nutrition: nothing to write.",
        }));
        if (res.created.macrosSkipped?.length) {
          box.append(el("div", { className: "muted", textContent: `Not written: ${res.created.macrosSkipped.join(", ")}` }));
        }
      }

      // WARNING: nothing is looked up here, and that is the design (changed 2026-08-04).
      //
      // Adding a row used to fire a paid lookup automatically whenever the boxes were empty, so an
      // ordinary Add could quietly spend up to 29 cents. Now the only road to a paid lookup is pressing
      // "Find Macros" first, reading what comes back, and then adding — whatever is written is something
      // a human actually saw. An add with empty boxes writes the row without nutrition and says so.
      if (!res.macrosFromForm) {
        box.append(el("div", {
          className: "muted",
          textContent: "No nutrition written — use Find Macros before adding if you want it looked up.",
        }));
      }
    } catch (err) {
      setStatus(err.message, "error");
      $("add").disabled = false;
    }
  });
}
