import { defineConfig } from "@rstest/core";

export default defineConfig({
  include: ["tests/**/*.test.ts"],
  testEnvironment: "node",
  tools: { swc: { jsc: { transform: { react: { runtime: "automatic" } } } } },
});
