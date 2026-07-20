import { pluginReact } from '@rsbuild/plugin-react';
import { defineConfig } from '@rstest/core';

export default defineConfig({
  include: ['tests/**/*.test.tsx'],
  plugins: [pluginReact()],
  testEnvironment: 'happy-dom',
});
