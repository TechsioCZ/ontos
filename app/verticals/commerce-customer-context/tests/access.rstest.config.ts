import { defineConfig } from '@rstest/core';

export default defineConfig({
  root: new URL('..', import.meta.url).pathname,
  testEnvironment: 'node',
  include: ['tests/unit/access*.test.ts'],
});
