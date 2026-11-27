import { afterEach } from "vitest";

// Fresh reads repeat in the background while visitors come; a test's reads stop with the test (the module instance the
// test used, also after vi.resetModules).
afterEach(async () => {
  (await import("@/ontos/fresh-read")).clearFreshReads();
});
