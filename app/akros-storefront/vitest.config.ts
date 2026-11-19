import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Next’s unbundled router loads its own published, compiled RSC runtime by package name.
process.env.NODE_PATH = fileURLToPath(
  new URL("./node_modules/next/dist/compiled", import.meta.url),
);

process.env.TURBOPACK = "1";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Keep ESM context imports on the same native context instances as Next's require hook.
      "next/dist/shared/lib/app-router-context.shared-runtime": fileURLToPath(
        new URL(
          "./node_modules/next/dist/server/route-modules/pages/vendored/contexts/app-router-context.js",
          import.meta.url,
        ),
      ),
      "next/dist/shared/lib/hooks-client-context.shared-runtime": fileURLToPath(
        new URL(
          "./node_modules/next/dist/server/route-modules/pages/vendored/contexts/hooks-client-context.js",
          import.meta.url,
        ),
      ),
      // Route-handler tests run outside Next's server-only module substitution.
      "server-only": fileURLToPath(
        new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url),
      ),
    },
  },
  test: {
    environment: "happy-dom",
    maxWorkers: 1,
    setupFiles: ["./tests/setup-match-media.ts"],
  },
});
