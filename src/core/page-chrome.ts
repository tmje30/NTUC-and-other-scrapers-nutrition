/**
 * The chrome both pages share: one stylesheet, one one-tap script.
 *
 * `site.ts` renders the daily deals; `history.ts` renders the page you click
 * into from its footer. They are two files on the same GitHub Pages site, and a
 * user moving between them should not be able to tell they were built by
 * different modules. Keeping the CSS and the dispatch script here rather than
 * copied into each is what makes that true as the pages change.
 *
 * The script is the same credential-free arrangement as before: every button is
 * a plain link to a pre-filled GitHub issue, upgraded to a one-tap
 * `repository_dispatch` when the browser is holding a token. The page itself
 * holds nothing.
 */

/** Every rule both pages use. History-only rules are at the bottom. */
export const PAGE_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f5f6f8; color: #1a1d21; padding: 16px; }
  .wrap { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 1.25rem; margin: 8px 2px 2px; }
  .sub { color: #6b7280; font-size: .85rem; margin: 0 2px 16px; }
  .section { font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin: 20px 2px 8px; }
  .empty-sm { color: #6b7280; font-size: .9rem; margin: 4px 2px 8px; }
  .card { display: flex; align-items: stretch; gap: 10px; color: inherit; background: #fff;
    border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  /* Everything but the Add button. A block (not a flex item) so the percentage
     column inside it can float — see .pctcol. The clearfix keeps the card tall
     enough when that column is taller than the text beside it. */
  .main { flex: 1; min-width: 0; }
  .main::after { content: ""; display: block; clear: both; }
  /* Must NOT establish a block formatting context (no overflow/contain here), or
     its text would stop flowing around the floated column and sit underneath it. */
  .body { display: block; text-decoration: none; color: inherit;
    transition: transform .05s ease; }
  .body:active { transform: scale(.995); }
  /* Add: pushes the item onto the Notion grocery list. Deliberately chunky — it's
     the one thing on this page you tap on purpose rather than to read more. */
  /* Buy, and Ignore 1wk beneath it. A column of its own, with a real gap so the
     two are never a mis-tap apart. Stretched, so they match in width.
     ⚠️ The gap used to be there because the lower button was permanent; since
     2026-08-05 it is the WEEKLY snooze (undoable from the list at the foot of the
     page) and the permanent one lives in the ⋯ menu. The gap stays anyway — a
     mis-tapped snooze still costs you a week of not being offered the item. */
  /* ⚠️ The max-width is load-bearing, not cosmetic. This column is stretch-sized by
     its widest child, so "Ignore 1wk" on one line widened it by ~45px and took that
     out of the product name on a phone. Capped, the label wraps to two short lines
     and the column stays at Buy's width. Widen this and every card loses text. */
  .cta { flex: 0 0 auto; align-self: flex-start; display: flex; flex-direction: column;
    align-items: stretch; gap: 12px; max-width: 78px; }
  .add { flex: 0 0 auto; display: inline-flex; align-items: center;
    justify-content: center; min-width: 52px; min-height: 34px; padding: 0 12px; font: inherit;
    font-size: .85rem; font-weight: 700; text-decoration: none; cursor: pointer;
    color: #067647; background: #ecfdf3; border: 1px solid #a6f4c5; border-radius: 9px;
    -webkit-tap-highlight-color: transparent; transition: transform .05s ease; }
  .add:active { transform: scale(.94); }
  .add[data-state="busy"], .act[data-state="busy"] { opacity: .6; }
  .add[data-state="done"] { color: #fff; background: #067647; border-color: #067647; }
  .add[data-state="failed"], .act[data-state="failed"] { color: #b42318; background: #fef3f2; border-color: #fecdca; }
  /* Recently-bought rows: quieter than a card, but the buttons still need a
     thumb-sized target, so the row is taller than the old one-line paragraph. */
  .snooze { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 5px 2px; }
  .sname { font-weight: 600; font-size: .95rem; }
  .acts { margin-left: auto; display: flex; gap: 6px; }
  .act { display: inline-flex; align-items: center; justify-content: center; min-height: 32px;
    padding: 0 10px; font: inherit; font-size: .78rem; font-weight: 600; text-decoration: none;
    cursor: pointer; color: #4b5563; background: #f3f4f6; border: 1px solid #e5e7eb;
    border-radius: 8px; white-space: nowrap; -webkit-tap-highlight-color: transparent;
    transition: transform .05s ease; }
  .act:active { transform: scale(.94); }
  .act[data-state="done"] { color: #067647; background: #ecfdf3; border-color: #a6f4c5; }
  /* Ignore 1wk: sits under Buy, so it takes that column's size, and is RED like the
     permanent one (asked for 2026-08-05). Both ignores therefore read as "this
     removes something" and the difference is the label and the two taps, not the
     colour — red no longer means "no undo" on its own.
     ⚠️ It WRAPS, overriding .act's nowrap, and that is the whole point. The .cta
     column is stretch-sized by its widest child, so a one-line "Ignore 1wk" widened
     it by ~45px and took that straight out of the product name on a phone — the
     same width the four-row card split was made to win back. Two short lines keep
     the column at Buy's width and cost nothing but a few pixels of height. */
  .act.week { min-height: 34px; font-size: .85rem; font-weight: 700;
    white-space: normal; line-height: 1.15; padding: 4px 8px; text-align: center; }
  /* The Ignore dropdown (1/2/3/4 weeks, added 2026-08-11). It is a <details> like
     the ⋯ menu, so it inherits the open/close and the tap-outside handler, but its
     summary is painted as the red button it replaced — .act.ignore and .act.week
     both out-specify .menu > summary, so only the sizing needs saying here. */
  .cta .menu.weeks { width: 100%; }
  .cta .menu.weeks > summary { width: 100%; min-width: 0; }
  /* ⚠️ The panel hangs off the LEFT edge, unlike every other .panel. This menu
     lives in the left-hand CTA column, where the shared "right: 0" would open a
     190px panel leftwards and put most of it off the side of a phone. */
  .menu.weeks .panel { left: 0; right: auto; min-width: 132px; }
  /* A card on its way out. Removed from the DOM when it finishes — this is only
     what makes the removal readable rather than a flicker. */
  .card.going { opacity: 0; transform: scale(.98);
    transition: opacity .22s ease, transform .22s ease; }
  /* Ignore, both of them: red, because they take something off the page. The
     permanent one lives in the ⋯ menu (since 2026-08-05), where .panel .act sizes
     it; colour is all this rule is for. "done" stays red rather than turning green
     — the outcome is a removal, not an addition. */
  .act.ignore { color: #b42318; background: #fef3f2; border-color: #fecdca;
    font-weight: 700; }
  .act.ignore[data-state="done"] { color: #fff; background: #b42318; border-color: #b42318; }
  .row1 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .name { font-weight: 650; font-size: 1.05rem; }
  .pack { color: #6b7280; font-weight: 500; font-size: .9rem; }
  .pct { color: #067647; font-weight: 700; background: #ecfdf3; border-radius: 8px; padding: 1px 8px; white-space: nowrap; }
  .price { margin-top: 3px; }
  .price b { font-size: 1.05rem; }
  .per100 { color: #6b7280; font-size: .9rem; }
  .mine { color: #ca8a04; font-size: .9rem; font-weight: 700; margin-left: 4px; white-space: nowrap; }
  .was { color: #9ca3af; text-decoration: line-through; font-size: .9rem; margin-left: 4px; }
  .meta { color: #6b7280; font-size: .85rem; margin-top: 4px; }
  .prodprice { color: #4b5563; font-weight: 600; }
  /* Usage and the has/no-macro tag share the last row. "clear: both" drops it below
     the rail, which is what gives this one line the full card width — the tag would
     otherwise be squeezed against the buttons. */
  .usage { clear: both; color: #6b7280; font-size: .85rem; margin-top: 2px;
    display: flex; align-items: center; gap: 8px; }
  .usage .tag { margin-left: auto; }
  .store { color: #1a1d21; font-weight: 600; }
  .sale { color: #b42318; font-weight: 600; }
  .empty { text-align: center; color: #6b7280; padding: 40px 0; }
  /* A shop missing from the scan. Loud enough to notice, quiet enough not to
     look like an error page — the deals below are still real. */
  .warn { color: #92400e; background: #fffaeb; border: 1px solid #fedf89; border-radius: 10px;
    font-size: .85rem; margin: 0 2px 14px; padding: 8px 12px; }
  /* Wraps on a phone so the hint drops under the button rather than squeezing it. */
  .warnrow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-top: 8px; }
  .warnhint { flex: 1 1 220px; font-size: .78rem; opacity: .85; }
  .act.rescan { color: #92400e; background: #fff; border-color: #fedf89; font-weight: 700; }
  .card.rec { border-style: dashed; background: #fcfcfd; }
  /* Percentage on top, "closest" beneath it, then the ⋯ menu — all hugging the
     right edge. A sibling of the product link, never inside it, so the menu is
     tappable without opening the store page.
     Floated rather than sat in a column of its own: the card's lines wrap around
     it while it lasts and then run the full width, which is what keeps a long
     product name at two lines instead of three. */
  .pctcol { float: right; margin: 0 0 4px 8px; display: flex; flex-direction: column;
    align-items: flex-end; gap: 3px; }
  /* The deal card's rail: the percentage and ⋯ menu, then Add / Replace / Macros.
     Same float as .pctcol and for the same reason, but "stretch" so the three
     buttons share one width and read as a group rather than three loose chips.
     Sized off the widest label ("Replace") — wide enough to tap, narrow enough
     that the five text rows beside it still fit a 390px phone. */
  .rail { float: right; margin: 0 0 4px 8px; display: flex; flex-direction: column;
    align-items: stretch; gap: 4px; width: 80px; }
  .rail .pct, .rail .menu { align-self: flex-end; }
  .rail .act { width: 100%; min-height: 27px; padding: 0 6px; font-size: .74rem; }
  /* One blank line between the menu and the buttons. Purely a separator: above it
     is what this deal IS, below it is what to do about it, and without the break
     Macros reads as a fourth entry in the ⋯ menu. */
  .railgap { height: 11px; }
  /* Macros: OFF is red and says "Macros", ON is green and says "+ Macros". Red for
     off is deliberate and the opposite of the usual convention — off is the safe,
     free state, and the colour is there to make an armed toggle obvious before you
     press Add, not to warn you about the safe one. The label change carries it for
     anyone who can't tell the two apart. */
  .act.macro { color: #b42318; background: #fef3f2; border-color: #fecdca; }
  .act.macro[aria-pressed="true"] { color: #067647; background: #ecfdf3; border-color: #a6f4c5; }
  .tag-has { color: #067647; background: #ecfdf3; border-color: #a6f4c5; }
  .tag-no { color: #6b7280; }
  .tag { color: #6b7280; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em;
    border: 1px solid #e5e7eb; border-radius: 8px; padding: 1px 7px; white-space: nowrap; }
  /* The correction menu. <details> gives open/close and keyboard access for free;
     the panel is absolute so opening it overlays the cards below instead of
     shoving the whole page down. */
  .menu { position: relative; margin-top: 1px; }
  .menu > summary { display: inline-flex; align-items: center; justify-content: center;
    min-width: 34px; min-height: 26px; padding: 0 8px; font-size: .8rem; line-height: 1;
    color: #6b7280; background: #f3f4f6; border: 1px solid #e5e7eb; border-radius: 8px;
    cursor: pointer; list-style: none; -webkit-tap-highlight-color: transparent; }
  .menu > summary::-webkit-details-marker { display: none; }
  .menu[open] > summary { color: #1a1d21; background: #e5e7eb; }
  .menu[data-state="done"] > summary { color: #067647; background: #ecfdf3; border-color: #a6f4c5; }
  .panel { position: absolute; right: 0; top: calc(100% + 4px); z-index: 10;
    display: flex; flex-direction: column; gap: 5px; min-width: 190px; padding: 6px;
    background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,.14); }
  .panel .act { width: 100%; justify-content: flex-start; min-height: 34px; }
  .why { color: #92400e; font-size: .82rem; margin-top: 4px; }
  /* Deliberately quiet: setting a token is a once-per-device errand, not a
     feature to advertise on every visit. */
  .foot { margin: 22px 2px 8px; font-size: .8rem; }
  .foot a { color: #9ca3af; text-decoration: none; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e5e7eb; }
    .sub, .pack, .meta, .per100, .usage, .section, .empty-sm { color: #9aa1ab; }
    .card { background: #171a1f; border-color: #262b32; box-shadow: none; }
    .pct { color: #6ee7b7; background: #06251a; }
    .store { color: #e5e7eb; }
    .was { color: #6b7280; }
    .mine { color: #facc15; }
    .prodprice { color: #cbd2dc; }
    .card.rec { background: #141619; }
    .tag { border-color: #2c323a; }
    .menu > summary { color: #cbd2dc; background: #1c2026; border-color: #2c323a; }
    .menu[open] > summary { color: #e5e7eb; background: #262b32; }
    .menu[data-state="done"] > summary { color: #6ee7b7; background: #06251a; border-color: #0b4a34; }
    .act.macro { color: #fda29b; background: #2a1412; border-color: #5a2420; }
    .act.macro[aria-pressed="true"] { color: #6ee7b7; background: #06251a; border-color: #0b4a34; }
    .tag-has { color: #6ee7b7; background: #06251a; border-color: #0b4a34; }
    .tag-no { color: #9aa1ab; }
    .panel { background: #171a1f; border-color: #2c323a; box-shadow: 0 8px 24px rgba(0,0,0,.5); }
    .why { color: #fbbf24; }
    .warn { color: #fbbf24; background: #241a06; border-color: #4a3410; }
    .act.rescan { color: #fbbf24; background: #1c1403; border-color: #4a3410; }
    .add { color: #6ee7b7; background: #06251a; border-color: #0b4a34; }
    .add[data-state="done"] { color: #04140e; background: #6ee7b7; border-color: #6ee7b7; }
    .add[data-state="failed"], .act[data-state="failed"] { color: #fda29b; background: #2b1512; border-color: #5c2420; }
    .act { color: #cbd2dc; background: #1c2026; border-color: #2c323a; }
    .act[data-state="done"] { color: #6ee7b7; background: #06251a; border-color: #0b4a34; }
    .act.ignore { color: #fda29b; background: #2b1512; border-color: #5c2420; }
    .act.ignore[data-state="done"] { color: #2b1512; background: #fda29b; border-color: #fda29b; }
    .foot a { color: #6b7280; }
  }

  /* ---- History page only ---------------------------------------------- */
  /* A row on the history page: the item on the left, its buttons on the right,
     wrapping onto a second line on a phone rather than squeezing them. */
  .hrow { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px 10px;
    background: #fff; border: 1px solid #e5e7eb; border-radius: 12px;
    padding: 11px 13px; margin-bottom: 8px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
  .hmain { flex: 1 1 220px; min-width: 0; }
  .hname { font-weight: 650; font-size: 1rem; }
  .hsub { color: #6b7280; font-size: .85rem; margin-top: 2px; }
  .hsub a { color: inherit; }
  /* The button row. margin-left:auto pushes it right on a wide screen and is
     harmless once the row wraps, where it simply starts the line. */
  .hacts { margin-left: auto; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  /* The primary action on a bought row — same green as Add on a deal card, so
     "this is the one you meant to press" reads the same on both pages. */
  .act.file { color: #067647; background: #ecfdf3; border-color: #a6f4c5; font-weight: 700; }
  .act.file[data-state="done"] { color: #fff; background: #067647; border-color: #067647; }
  /* Intro line under a section heading — says what the buttons will do before
     you tap one, since several of these write to Notion. */
  .hnote { color: #6b7280; font-size: .82rem; margin: -2px 2px 10px; }
  /* A settled row: kept visible as a record, but visibly done. */
  .hrow.done { background: #fcfcfd; border-style: dashed; }
  .hdone { color: #067647; font-size: .78rem; font-weight: 600; white-space: nowrap; }
  .hnever { color: #b42318; }
  .back { display: inline-block; margin: 0 2px 14px; font-size: .85rem; color: #6b7280;
    text-decoration: none; }
  @media (prefers-color-scheme: dark) {
    .hrow { background: #171a1f; border-color: #262b32; box-shadow: none; }
    .hrow.done { background: #141619; }
    .hsub, .hnote, .back { color: #9aa1ab; }
    .act.file { color: #6ee7b7; background: #06251a; border-color: #0b4a34; }
    .act.file[data-state="done"] { color: #04140e; background: #6ee7b7; border-color: #6ee7b7; }
    .hdone { color: #6ee7b7; }
    .hnever { color: #fda29b; }
  }
`;

/** What the shared script needs to know. `PageOptions` in `site.ts` extends it. */
export interface ChromeOptions {
	/** "owner/repo" — where a button files its request. */
	repo: string;
	/** One-tap POST endpoint. Empty ⇒ the GitHub issue link is the only path. */
	addEndpoint?: string;
}
/**
 * The only behaviour the correction menu needs beyond what `<details>` already
 * does: a tap anywhere else closes it. Without this an open menu stays open until
 * you find its own ⋯ again, and on a phone that reads as a stuck page.
 *
 * Emitted on both paths (one-tap and relay), because the menus are rendered
 * either way — everything else about them works with JavaScript off.
 */
export function menuScript(): string {
	return `<script>
(function () {
  document.addEventListener("click", function (ev) {
    var open = document.querySelector("details.menu[open]");
    // Capture phase, so this runs before the action handler below and a tap on a
    // menu item still reaches it. A tap INSIDE the open menu is left alone —
    // <summary> does its own toggling.
    if (open && !open.contains(ev.target)) open.open = false;
  }, true);
})();
</script>
${macroToggleScript()}`;
}

/**
 * The per-card **+ Macros** toggle.
 *
 * Arming it has to reach BOTH roads out of this page, because the page is static
 * and has two:
 *
 *   one-tap  — \`data-payload\` JSON, dispatched straight at the workflow.
 *   two-tap  — the pre-filled GitHub issue \`href\`, whose body is URL-encoded.
 *
 * So the flag is baked in as \`"findMacros": false\` on both, and this flips the
 * text of each. That is why \`ingredientPayload\` always serialises the field even
 * though it is always false: a string replace can only rewrite a value that is
 * actually there, and a toggle that silently worked on one path and not the other
 * would be the worst of both.
 *
 * No persistence, deliberately. It resets on reload and the page is rebuilt daily
 * — a switch that spends money should not survive out of sight.
 */
function macroToggleScript(): string {
	// The exact spacing `JSON.stringify(p, null, 2)` produces, then URL-encoded the
	// way encodeURIComponent does. Both halves must match the generated markup, so
	// they are written once here rather than guessed at in two places.
	return `<script>
(function () {
  var RAW_OFF = '"findMacros": false', RAW_ON = '"findMacros": true';
  var ENC_OFF = encodeURIComponent(RAW_OFF), ENC_ON = encodeURIComponent(RAW_ON);

  document.addEventListener("click", function (ev) {
    var btn = ev.target.closest("[data-macro-toggle]");
    if (!btn) return;
    ev.preventDefault();
    var on = btn.getAttribute("aria-pressed") !== "true";
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.textContent = on ? "+ Macros" : "Macros";

    // Every Ingredients button on THIS card only. The rail is the scope, so a
    // toggle can never arm the card below it.
    var rail = btn.closest(".rail");
    if (!rail) return;
    rail.querySelectorAll("[data-payload]").forEach(function (el) {
      var p = el.getAttribute("data-payload") || "";
      // Buy lives outside the rail, but guard anyway: only the two Ingredients
      // actions carry the flag, and rewriting anything else would be a bug.
      if (p.indexOf("findMacros") < 0) return;
      el.setAttribute("data-payload", on ? p.replace(/"findMacros":false/, '"findMacros":true')
                                         : p.replace(/"findMacros":true/, '"findMacros":false'));
      var href = el.getAttribute("href");
      if (href) el.setAttribute("href", on ? href.split(ENC_OFF).join(ENC_ON) : href.split(ENC_ON).join(ENC_OFF));
    });
  });
})();
</script>
`;
}

/**
 * One tap, with no server anywhere.
 *
 * `api.github.com` answers cross-origin requests — a preflighted, authenticated
 * POST from `tmje30.github.io` comes back with a readable status, verified
 * 2026-07-29. So the page can fire `repository_dispatch` at the `add-to-list`
 * workflow itself, using a fine-grained PAT the user pastes in once. The token
 * lives only in that browser's localStorage: never in the repo, the page source,
 * or a build artifact.
 *
 * Why this rather than a relay service: it's free, there's nothing to deploy,
 * and — unlike a POST to a Notion webhook, which returns no CORS headers and so
 * an opaque response — the button can read the real status and tell the truth
 * about whether GitHub accepted the job.
 *
 * It is strictly an upgrade over the link underneath it. No token, a cancelled
 * prompt, a revoked token, JavaScript disabled: every one of those falls back to
 * the two-tap issue flow instead of failing.
 */
function githubOneTapScript(o: ChromeOptions): string {
	return `<script>
(function () {
  var REPO = ${JSON.stringify(o.repo)};
  var KEY = "grocery-add-pat";
  var toggle;

  var token = function () { return localStorage.getItem(KEY) || ""; };

  function paint() {
    if (!toggle) return;
    toggle.textContent = token() ? "⚡ one-tap on · tap to remove token" : "⚡ enable one-tap";
  }

  function configure() {
    if (token()) {
      if (confirm("Remove the saved token? Add will go back to opening GitHub.")) {
        localStorage.removeItem(KEY);
      }
    } else {
      var t = (prompt(
        "Paste a GitHub fine-grained token for this repo (Contents: read and write).\\n\\n" +
        "It is stored only in this browser."
      ) || "").trim();
      if (t) localStorage.setItem(KEY, t);
    }
    paint();
  }

  // ---- An accepted ignore takes the card off the page -------------------
  //
  // Runs only after GitHub has ACCEPTED the job, and only for a button carrying
  // data-hide-card. The two-tap path never gets here on purpose: there the click
  // opens a pre-filled issue the user may yet abandon, and a card that vanished
  // on a request never submitted would be the page lying about what it did.
  //
  // The scope comes from the button: "key" clears every card for the INGREDIENT
  // (nothing is searched for it now), "url" every card offering the PRODUCT (it
  // is never offered again, whichever item it matched). Matched in JS rather than
  // with an attribute selector — a product URL is full of characters a selector
  // would have to be escaped for.
  function matching(scope, want) {
    var out = [];
    document.querySelectorAll(".card").forEach(function (c) {
      if (c.getAttribute("data-" + scope) === want) out.push(c);
    });
    return out;
  }

  function hideCards(btn) {
    var card = btn.closest(".card");
    if (!card) return;
    var scope = btn.dataset.hideCard;
    var want = card.getAttribute("data-" + scope);
    var cards = want ? matching(scope, want) : [card];
    cards.forEach(function (c) { c.classList.add("going"); });
    setTimeout(function () {
      cards.forEach(function (c) { c.remove(); });
      prune();
    }, 240);
  }

  // A section heading with nothing left under it, and a count that no longer
  // matches what is on screen, both outlive the cards they described. Re-derived
  // from the live DOM rather than tracked, so it stays right however many cards
  // one tap took (an ignored ingredient can own several).
  function prune() {
    var head = null, live = false;
    var settle = function () { if (head) head.style.display = live ? "" : "none"; };
    document
      .querySelectorAll(".wrap > h2.section, .wrap > .card, .wrap > .snooze, .wrap > .empty-sm")
      .forEach(function (el) {
        if (el.tagName === "H2") { settle(); head = el; live = false; }
        else live = true;
      });
    settle();
    // Recommendations are close matches, not deals, and were never in this total.
    var n = document.querySelectorAll(".card:not(.rec)").length;
    var label = document.getElementById("dealcount");
    if (label) label.textContent = n + " deal" + (n === 1 ? "" : "s");
  }

  function dispatch(btn) {
    var label = btn.textContent;
    btn.dataset.state = "busy";
    btn.textContent = "…";
    fetch("https://api.github.com/repos/" + REPO + "/dispatches", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token(),
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      // Nested: GitHub rejects a client_payload with over 10 top-level keys.
      body: JSON.stringify({
        event_type: btn.dataset.event || "add-to-list",
        client_payload: { payload: JSON.parse(btn.dataset.payload) }
      })
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          // Bad or revoked token: forget it, so the next tap opens the issue.
          localStorage.removeItem(KEY);
          paint();
          throw new Error("auth");
        }
        if (!r.ok) throw new Error(r.status);
        // 204 = GitHub accepted the job; the row appears ~15s later. This is the
        // FINAL state — nothing polls afterwards — so the label has to read as
        // finished. "queued" did not: it looks like a pending state, and you sit
        // there waiting for it to change into something else.
        btn.dataset.state = "done";
        btn.textContent = btn.dataset.done || "✓ sent";
        // A menu item's new label is inside a panel that is about to close, so the
        // menu itself has to carry the result — otherwise the only feedback for a
        // correction is a popup vanishing.
        var menu = btn.closest && btn.closest("details.menu");
        if (menu) {
          menu.open = false;
          menu.dataset.state = "done";
          var sum = menu.querySelector("summary");
          // A labelled summary (the Ignore dropdown) says what it settled on; the
          // ⋯ menu has no label to keep, so a bare tick is the whole message.
          if (sum) sum.textContent = menu.dataset.done || "✓";
        }
        // Last, and after a beat: the tick above is the only confirmation there is,
        // so it has to be read before the card carrying it leaves.
        if (btn.dataset.hideCard) setTimeout(function () { hideCards(btn); }, 420);
      })
      .catch(function (e) {
        btn.dataset.state = "failed";
        btn.textContent = e.message === "auth" ? "token?" : "retry";
        setTimeout(function () { btn.dataset.state = ""; btn.textContent = label; }, 4000);
      });
  }

  document.addEventListener("click", function (ev) {
    if (!ev.target.closest) return;
    if (ev.target.closest("#onetap")) { ev.preventDefault(); configure(); return; }

    // Every button on the page carries its payload the same way — Add, and the
    // Reset/park buttons on a snoozed item. data-event picks the workflow.
    var btn = ev.target.closest("[data-payload]");
    if (!btn || btn.dataset.state === "busy" || btn.dataset.state === "done") return;
    // No token? Do nothing and let the link open the pre-filled issue.
    if (!token()) return;
    // Only the destructive buttons set data-confirm. Cancelling must not fall
    // through to the link, or "no" would open the issue form instead.
    if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) {
      ev.preventDefault();
      return;
    }
    // "Mismatch item" ships a list of words the page GUESSED at, so it is shown
    // for editing before anything is banned — the guess includes the brand, and
    // banning a brand for an item is the user's call. Cancelling, or clearing the
    // box, sends nothing: an empty exclusion is not a correction. (Without a token
    // the same list travels in the issue body, which is editable there instead.)
    if (btn.dataset.prompt) {
      var edited = prompt(btn.dataset.prompt, btn.dataset.terms || "");
      ev.preventDefault();
      if (edited === null) return;
      var terms = edited.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      if (!terms.length) return;
      var body = JSON.parse(btn.dataset.payload);
      body.terms = terms;
      btn.dataset.payload = JSON.stringify(body);
      btn.dataset.terms = terms.join(", ");
      dispatch(btn);
      return;
    }
    ev.preventDefault();
    dispatch(btn);
  });

  // Shared setup link: opening ".../#add-token=XXX" stores the token and strips
  // it back out of the address bar, so a second person (partner sharing the
  // page) is set up by tapping one link instead of pasting a token on a phone.
  // The fragment is never sent to the server — but it DOES persist in whatever
  // chat you sent it through, so treat such a link as the secret it contains.
  var shared = location.hash.match(/[#&]add-token=([^&]+)/);
  if (shared) {
    localStorage.setItem(KEY, decodeURIComponent(shared[1]));
    history.replaceState(null, "", location.pathname + location.search);
  }

  toggle = document.getElementById("onetap");
  paint();
})();
</script>
`;
}

/**
 * Client-side half of the relay one-tap path (a Notion Worker webhook). Only
 * emitted when an endpoint is configured; otherwise the page uses the
 * GitHub-direct script above, which needs no service at all.
 *
 * Two constraints shape this, both from the Notion Worker webhook on the other
 * end (see `docs/one-tap-add.md`):
 *
 *  • It returns no CORS headers, so the request must be a "simple" one — POST,
 *    `text/plain`, no custom headers — to avoid a preflight the browser would
 *    reject. `mode: "no-cors"` sends it; the response comes back opaque.
 *  • Opaque means we cannot read the status. The tick therefore means "sent",
 *    not "confirmed" — the row itself shows up in Notion a few seconds later.
 *    That honesty is why this path is opt-in and the issue button is default.
 *
 * The endpoint lives in a public page, so it's gated by a token the user is
 * asked for once and the browser then remembers.
 */
export function addScript(o: ChromeOptions): string {
	if (!o.addEndpoint) return githubOneTapScript(o);
	return `<script>
(function () {
  var endpoint = ${JSON.stringify(o.addEndpoint)};
  var KEY = "grocery-add-token";

  function token() {
    var t = localStorage.getItem(KEY);
    if (!t) {
      t = (prompt("One-time setup: paste your Add token") || "").trim();
      if (t) localStorage.setItem(KEY, t);
    }
    return t;
  }

  document.addEventListener("click", function (ev) {
    // Relay path: adds only. The item-action buttons keep their issue links.
    var btn = ev.target.closest ? ev.target.closest(".add[data-payload]") : null;
    if (!btn || btn.dataset.state === "busy" || btn.dataset.state === "done") return;
    ev.preventDefault();

    var t = token();
    if (!t) return;

    var label = btn.textContent;
    var body = JSON.parse(btn.dataset.payload);
    body.token = t;

    btn.dataset.state = "busy";
    btn.textContent = "…";
    fetch(endpoint, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
    })
      .then(function () {
        // Opaque response: delivered, not verified. Say "sent", not "added".
        btn.dataset.state = "done";
        btn.textContent = "sent";
      })
      .catch(function () {
        btn.dataset.state = "failed";
        btn.textContent = "retry";
        setTimeout(function () {
          btn.dataset.state = "";
          btn.textContent = label;
        }, 4000);
      });
  });
})();
</script>
`;
}

