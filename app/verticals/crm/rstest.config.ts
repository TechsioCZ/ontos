import { createRequire } from 'node:module';
import { withModernConfig } from '@modern-js/adapter-rstest';
import { defineConfig } from '@rstest/core';

Object.assign(globalThis, { require: createRequire(import.meta.url) });

export default defineConfig({
  clearMocks: true,
  extends: withModernConfig({
    configPath: './modern.rstest.config.ts',
  }),
  include: ['tests/components/**/*.{test,spec}.?(c|m)[jt]s?(x)'],
  output: {
    module: true,
  },
  restoreMocks: true,
  testEnvironment: 'happy-dom',
});
