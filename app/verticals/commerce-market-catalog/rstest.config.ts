import { defineConfig } from '@rstest/core';

const root = import.meta.dirname;

const swc = {
  jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } },
} as const;

// Unit tests include component tests (.tsx): JSX with the automatic runtime, as the merchandise vertical does.
const unitSwc = {
  jsc: { parser: { syntax: 'typescript', tsx: true }, transform: { react: { runtime: 'automatic' } } },
} as const;

export default defineConfig({
  projects: [
    {
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      root,
      setupFiles: ['../../scripts/ci/integration-worker-setup.mts'],
      testEnvironment: 'node',
      // The real-owner Market suites take about 20 s on an idle runner (23 s on main), so 30 s left no margin
      // for a loaded one.
      testTimeout: 60_000,
      tools: { swc },
    },
    {
      include: ['tests/unit/**/*.test.{ts,tsx}'],
      name: 'unit',
      root,
      testEnvironment: 'node',
      // Main's unit tests measured 568 ms at most (gates runs 43616061381 and 43844802542), which gave the
      // shared 2400 ms floor. Demo's component tests (.tsx) were not in that measurement: the first one of a file
      // pays the DOM and module load and took 2.57 s on a loaded runner (gates run 44260866014), over the floor.
      testTimeout: 6000,
      tools: { swc: unitSwc },
    },
  ],
  root,
});
