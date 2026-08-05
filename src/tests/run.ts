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
import { report } from "./harness.js";

report();
