/**
 * Every suite, one process, one exit code — `npm test`.
 *
 * Suites are imported for their side effects: each file registers its cases at
 * module load, and `report()` prints them and sets the exit code. Adding a suite
 * means one import line here and nothing else.
 *
 * Everything is offline and free. Nothing here calls Notion, a shop, or the
 * Anthropic API — a test that costs 29 cents is a test nobody runs. The live
 * checks that DO cost something have their own scripts (`npm run macro-test`,
 * `npm run fp`, `npm run ss`) and are deliberately not wired in here.
 */
import "./packshots.test.js";
import "./nutrition-panel.test.js";
import "./macro-reply.test.js";
import "./naming.test.js";
import "./human-name.test.js";
import "./deals-page.test.js";
import "./scan-request.test.js";
import "./marketplace-size.test.js";
import "./cooldown.test.js";
import "./merge-data.test.js";
import "./grocery-list.test.js";
import "./vendor-slots.test.js";
import "./carousell.test.js";
import "./vendor-scan.test.js";
import "./vendor-review.test.js";
import "./list-parse.test.js";
import "./list-intake.test.js";
import "./new-items.test.js";
import "./scan-file.test.js";
import "./weight-in-text.test.js";
import "./intake-candidates.test.js";
import "./directed-search.test.js";
import "./sgt.test.js";
import { report } from "./harness.js";

// Imported dynamically, and last, because these suites `await` — one writes real
// state files to a temp dir, the other drives real git against a temp remote (see
// their headers). A static import would let the other suites' `describe()` calls
// run inside their await windows, and every case registered after one would be
// filed under whichever suite name happened to be current. Loading them alone,
// after the rest and one at a time, keeps the labels honest.
await import("./tg-state.test.js");
// ⚠️ This one also REPLACES `globalThis.fetch` while it runs, and puts it back at
// the end. Another suite loading inside its await window would be running against
// the stub — another reason these load one at a time.
await import("./tg-sweep.test.js");
await import("./git-data-push.test.js");

report();
