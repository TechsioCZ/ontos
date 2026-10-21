import { defineConfig } from '@rstest/core';

export default defineConfig({
  include: ['tests/unit/**/*.test.ts'],
  root: new URL('.', import.meta.url).pathname,
  testEnvironment: 'node',
  tools: { swc: { jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } } } },
});
