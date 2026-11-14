// Fails when the storefront API key appears anywhere in the browser bundle (.next/static).
// Usage after `next build`: ONTOS_AKROS_STOREFRONT_API_KEY=… node scripts/check-browser-bundle.mjs
// The key is read from the environment (or ../.env.demo.local for the local demo) and never printed.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const demoEnv = fileURLToPath(new URL("../../.env.demo.local", import.meta.url));
if (!process.env.ONTOS_AKROS_STOREFRONT_API_KEY && existsSync(demoEnv))
  process.loadEnvFile(demoEnv);
const key = process.env.ONTOS_AKROS_STOREFRONT_API_KEY;
const root = fileURLToPath(new URL("../.next/static", import.meta.url));
if (!existsSync(root)) {
  console.error("[akros] .next/static is missing; run next build first");
  process.exit(1);
}
if (!key) {
  console.error("[akros] ONTOS_AKROS_STOREFRONT_API_KEY is not set; nothing to check against");
  process.exit(1);
}
const needle = Buffer.from(key);
let files = 0;
const scan = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) scan(path);
    else {
      files += 1;
      if (readFileSync(path).includes(needle)) {
        console.error(`[akros] API key found in browser output: ${path.slice(root.length + 1)}`);
        process.exit(1);
      }
    }
  }
};
scan(root);
console.log(`[akros] Browser output: no API key (${files} files checked)`);
