import { afterEach } from "@rstest/core";

// Fresh reads repeat in the background while visitors come; a test's reads stop with the test (the module instance the
// test used, also after module resets).
afterEach(async () => {
  const { clearFreshReads } = await import("../src/ontos/fresh-read");
  clearFreshReads();
});
