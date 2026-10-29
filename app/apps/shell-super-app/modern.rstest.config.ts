import { appTools } from '@modern-js/app-tools';
import { defineConfig } from '@modern-js/ultramodern-app-tools';

export default defineConfig({
  plugins: [appTools()],
  // Match the Shell's real-React federation runtime in browser lifecycle tests.
  redact: false,
});
