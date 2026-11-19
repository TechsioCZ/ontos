import { defineConfig } from '@rstest/core';

// SWC rejects every generic arrow function in `.mts` files (even `<T,>(...)`) under its
// default mts/cts parser mode, and Rstest bundles the imported scripts through SWC.
const swc = {
  jsc: { parser: { disallowAmbiguousJsxLike: false, syntax: 'typescript' } },
} as const;

const shared = {
  testEnvironment: 'node',
  testTimeout: 120_000,
  tools: { swc },
} as const;

// Operator acceptance needs an environment no gate provisions: the reset Nájempark stack serving on
// localhost:3020, and the reviewed agent-profile replay input against a people_model_scratch_* database.
// `pnpm test:operator` runs them; scripts/demo/README.md describes their preparation.
const operatorTests = [
  'scripts/integration/agent-profile-replay.test.mts',
  'scripts/integration/siampark-demo-http.test.mts',
];

// Migration equivalence creates its own databases and fixture roles on a PostgreSQL 18 cluster its job owns and
// names (MIGRATION_EQUIVALENCE_TEST_DATABASE_URL). An integration lane's cluster holds the shared baseline and no
// such endpoint, so the deployment bootstrap row runs this project on the cluster it migrates itself.
const ownedClusterTests = ['scripts/integration/migration-equivalence.test.mts'];
// Negated include patterns, not `exclude`: a command-line --exclude (the root tasks of
// scripts/ci/run-integration-suites.sh) replaces a project's exclude list, so these files would rejoin the suite.
const elsewhere = [...operatorTests, ...ownedClusterTests].map((file) => `!${file}`);

export default defineConfig({
  projects: [
    {
      ...shared,
      exclude: ['scripts/scaffolding/**', 'scripts/integration/**'],
      include: ['scripts/**/*.test.mts'],
      name: 'scripts',
    },
    {
      ...shared,
      include: ['scripts/integration/**/*.test.mts', ...elsewhere],
      name: 'integration',
      setupFiles: ['./scripts/ci/integration-worker-setup.mts'],
    },
    {
      ...shared,
      include: operatorTests,
      name: 'operator',
    },
    {
      ...shared,
      include: ownedClusterTests,
      name: 'owned-cluster',
    },
    {
      ...shared,
      include: ['scripts/scaffolding/tests/**/*.test.mts'],
      name: 'generation',
    },
    {
      ...shared,
      include: ['tools/oxlint/effect-native/tests/*.test.mts'],
      name: 'lint-rules',
    },
  ],
});
