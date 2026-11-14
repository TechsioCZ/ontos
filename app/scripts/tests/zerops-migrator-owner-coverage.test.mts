import { readFileSync } from 'node:fs';

import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const migrator = readFileSync(new URL('../run-zerops-migrator.mjs', import.meta.url), 'utf-8');
const deployment = Result.getOrThrow(
  Schema.decodeUnknownResult(
    Schema.Struct({
      zerops: Schema.Array(
        Schema.Struct({
          build: Schema.optional(Schema.Struct({ deployFiles: Schema.optional(Schema.Array(Schema.String)) })),
          setup: Schema.String,
        }),
      ),
    }),
  )(parse(readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8'))),
);
const appDeployment = deployment.zerops.find((service) => service.setup === 'app');

for (const owner of [
  'price-group-catalog',
  'assortment',
  'commerce-market-catalog',
  'pricing',
  'privacy',
  'projects',
  'storefront-registry',
  'property-portfolio',
  'property-leasing',
  'legal-agreements',
  'work-tasks',
  'workforce',
  'tagging',
  'crm',
  'sales-pipeline',
  'merchandise',
  'facility-operations',
  'sales-insights',
  'finance-billing',
  'crm-activities',
  'payment',
  'promotion',
  'symmy-integration',
]) {
  it(`D1 migrates and packages ${owner} before claiming database readiness`, () => {
    const migration = migrator.indexOf(`yield* migrate('verticals/${owner}', 'drizzle.config.ts');`);
    expect(migration).toBeGreaterThan(-1);
    // Every owner migration belongs to the migration phase, which the verification phase follows.
    expect(migration).toBeGreaterThan(migrator.indexOf('const ownerMigrations = Effect.gen('));
    expect(migration).toBeLessThan(migrator.indexOf('const migrations = Effect.gen('));
    // The application container runs the migrator from the whole workspace, so every owner ships with it.
    expect(appDeployment?.build?.deployFiles).toContain('app/');
  });
}

it('the migrator verifies only after every migration, and activates access only after the foundation is verified', () => {
  expect(migrator).toContain("const VERIFY_APPLICATION_DATABASE = 'scripts/verify-application-db-schema.mts';");
  expect(migrator).toContain('yield* Effect.andThen(migrations, verificationAndActivation)');
  const phase = migrator.slice(migrator.indexOf('const verificationAndActivation = Effect.gen('));
  const foundation = phase.indexOf("yield* runAppScript(VERIFY_APPLICATION_DATABASE, ['--part=foundation'])");
  const together = phase.indexOf('return yield* Effect.all(');
  expect(foundation).toBeGreaterThan(-1);
  expect(together).toBeGreaterThan(foundation);
  const parallel = phase.slice(together, phase.indexOf('concurrency: 2'));
  expect(parallel).toContain("runAppScript(VERIFY_APPLICATION_DATABASE, ['--part=owners'])");
  expect(parallel).toContain('activateAccessRelease');
  // The activation appears nowhere else: it never runs before the foundation is proven.
  expect(migrator.split('activateAccessRelease').length).toBe(3);
});

it('the migrator asks the pending-migration planner before every native owner migration', () => {
  const migrate = migrator.slice(migrator.indexOf('const migrate = '), migrator.indexOf('const closeServer = '));
  const decided = migrate.indexOf('.decide(relativeDirectory, config)');
  const skipped = migrate.indexOf('if (decision.nothingToApply)');
  const spawned = migrate.indexOf("'drizzle-kit'");
  expect(decided).toBeGreaterThan(-1);
  expect(skipped).toBeGreaterThan(decided);
  expect(spawned).toBeGreaterThan(skipped);
  expect(migrator).toContain('Effect.provide(OwnerMigrationPlannerLive(appDirectory)');
});
