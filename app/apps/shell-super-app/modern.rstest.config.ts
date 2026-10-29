import { defineConfig } from '@modern-js/ultramodern-app-tools';

export default defineConfig({
  // Match the Shell's real-React federation runtime in browser lifecycle tests.
  redact: false,
});
