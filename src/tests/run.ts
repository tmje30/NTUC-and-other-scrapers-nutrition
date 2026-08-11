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
import "./deals-page.test.js";
import "./marketplace-size.test.js";
import "./cooldown.test.js";
import "./merge-data.test.js";
import "./grocery-list.test.js";
import "./vendor-slots.test.js";
import "./carousell.test.js";
import "./vendor-scan.test.js";
import "./list-parse.test.js";
import "./list-intake.test.js";
import "./new-items.test.js";
import "./scan-file.test.js";
import "./weight-in-text.test.js";
import "./intake-candidates.test.js";
import { report } from "./harness.js";

// Imported dynamically, and last, because this one suite has to `await` (it
// drives real git against a temp remote — see its header). A static import
// would let the other suites' `describe()` calls run inside its await windows,
// and every case registered after one would be filed under whichever suite name
// happened to be current. Loading it alone, after the rest, keeps the labels
// honest.
await import("./git-data-push.test.js");

report();
