import { fileURLToPath } from "node:url";

import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["tests/**/*.test.ts"],
  resolve: {
    alias: {
      // Route-handler tests run outside Next's server-only module substitution.
      "server-only": fileURLToPath(
        new URL("./node_modules/next/dist/compiled/server-only/empty.js", import.meta.url),
      ),
    },
  },
  testEnvironment: "node",
  tools: { swc: { jsc: { transform: { react: { runtime: "automatic" } } } } },
});
