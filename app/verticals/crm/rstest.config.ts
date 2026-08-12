import { createRequire } from 'node:module';
import { pluginReact } from '@rsbuild/plugin-react';
import { defineConfig } from '@rstest/core';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

export default defineConfig({
  clearMocks: true,
  include: ['tests/unit/**/*.test.tsx'],
  output: {
    module: false,
  },
  plugins: [pluginReact()],
  restoreMocks: true,
  testEnvironment: 'happy-dom',
});
