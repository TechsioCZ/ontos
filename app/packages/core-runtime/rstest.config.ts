import { defineConfig } from '@rstest/core';

// People-model scratch proofs need a migrated people_model_scratch_* database and a local SpiceDB whose schema
// they rewrite; no gate provisions one. `pnpm test:operator` runs them (app/scripts/demo/README.md).
const operatorTests = [
  'tests/integration/company-membership-runtime.test.ts',
  'tests/integration/configure-agent-runtime.test.ts',
  'tests/integration/manage-agent-status-runtime.test.ts',
  'tests/integration/replace-agent-operators-runtime.test.ts',
];

export default defineConfig({
  projects: [
    {
      include: ['tests/unit/**/*.test.ts'],
      name: 'unit',
      testEnvironment: 'node',
    },
    {
      exclude: operatorTests,
      include: ['tests/integration/**/*.test.ts'],
      name: 'integration',
      testEnvironment: 'node',
      testTimeout: 30_000,
    },
    {
      include: operatorTests,
      name: 'operator',
      testEnvironment: 'node',
      testTimeout: 30_000,
    },
  ],
});
