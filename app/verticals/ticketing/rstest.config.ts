import { pluginReact } from '@rsbuild/plugin-react';
import { defineConfig } from '@rstest/core';

export default defineConfig({
  include: ['tests/**/*.test.tsx'],
  plugins: [pluginReact()],
  setupFiles: ['./rstest.setup.ts'],
  testEnvironment: 'happy-dom',
});
