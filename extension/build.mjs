// Extension bundler. Run from the repo root:  npm run ext:build
//
// Why a build step at all: the extension imports the PROJECT's own modules directly
// (src/core/match.ts, generic-name.ts, categorize.ts, ingredients-schema.ts) — shared, not copied — so the
// extension and the daily scraper can never drift on what a generic name, a category or a similar item is.
// Two things stand between those modules and a browser:
//
//   1. They are TypeScript, imported with NodeNext ".js" specifiers that point at ".ts" files on disk.
//      The `ts-paths` plugin below resolves that.
//   2. match.ts reads synonyms.json off disk at startup (node:fs). The `node-stubs` plugin swaps
//      node:fs/path/url for shims whose readFileSync returns synonyms.json AS OF BUILD TIME.
//
// ⚠️ Consequence of (2): after editing synonyms.json, re-run this build and reload the unpacked extension,
// or it keeps matching with the old synonym set while the scraper uses the new one.
import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const synonyms = fs.readFileSync(path.join(root, "synonyms.json"), "utf8");

// NodeNext TypeScript writes `import "./match.js"` for a file that is actually `match.ts`. esbuild resolves
// the literal path, finds nothing, and fails — so map a relative ".js" specifier with no ".js" on disk to
// its ".ts" sibling.
const tsPaths = {
  name: "ts-paths",
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const asJs = path.resolve(args.resolveDir, args.path);
      if (fs.existsSync(asJs)) return null; // a real .js file — leave it alone
      const asTs = asJs.replace(/\.js$/, ".ts");
      return fs.existsSync(asTs) ? { path: asTs } : null;
    });
  },
};

const nodeStubs = {
  name: "node-stubs",
  setup(build) {
    build.onResolve({ filter: /^node:(fs|path|url)$/ }, (args) => ({ path: args.path, namespace: "node-stub" }));
    build.onLoad({ filter: /.*/, namespace: "node-stub" }, (args) => {
      if (args.path === "node:fs") {
        // match.ts only calls readFileSync(SYN_FILE) — hand it the baked synonyms whatever the path.
        // Named AND default exports: match.ts uses `import { readFileSync } from "node:fs"`.
        return { contents: `export const readFileSync = () => ${JSON.stringify(synonyms)};\nexport const accessSync = () => {};\nexport default { readFileSync, accessSync };` };
      }
      if (args.path === "node:path") {
        return { contents: `export const join = (...a) => a.join("/");\nexport const dirname = (p) => String(p);\nexport default { join, dirname };` };
      }
      return { contents: `export const fileURLToPath = (u) => String(u);\nexport default { fileURLToPath };` }; // node:url
    });
  },
};

// The project's config.ts reads process.env at module load. Nothing the extension imports touches it today,
// but `process` doesn't exist in a browser service worker, and if that ever changes the worker would die
// before handling a single message — with the popup just spinning. Cheap insurance.
const common = {
  bundle: true,
  plugins: [tsPaths, nodeStubs],
  absWorkingDir: here,
  outdir: path.join(here, "dist"),
  logLevel: "info",
  target: ["chrome120"],
  banner: { js: "globalThis.process ??= { env: {} };" },
};

// background + extension pages run as ES modules; content scripts are classic scripts → IIFE.
// popup.js and sidepanel.js both bundle the shared flow.js (they drive identical body ids).
await esbuild.build({ ...common, format: "esm", entryPoints: ["background.js", "popup.js", "sidepanel.js", "options.js"] });
await esbuild.build({ ...common, format: "iife", entryPoints: ["content.js"] });
console.log("✓ extension/dist is up to date — reload the unpacked extension in chrome://extensions.");
