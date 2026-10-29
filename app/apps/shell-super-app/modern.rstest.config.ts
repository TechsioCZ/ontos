import { defineConfig } from '@modern-js/ultramodern-app-tools';

export default defineConfig({
  // Redact 0.2.1 copies only enumerable event fields into its synthetic events, and happy-dom keeps
  // Event.target non-enumerable, so happy-dom lifecycle tests stay on real React until Redact copies them.
  redact: false,
});
