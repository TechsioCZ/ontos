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
    for (const runtime of [
      'app/node_modules',
      'app/apps',
      'app/verticals',
      'app/packages',
      'app/scripts',
      'app/database',
      'app/topology',
    ]) {
      expect(appDeployment?.build?.deployFiles).toContain(runtime);
    }
  });
}

it('the migrator verifies every owner schema after every migration, and only then activates access', () => {
  expect(migrator).toContain('yield* Effect.andThen(migrations, verificationAndActivation)');
  const phase = migrator.slice(migrator.indexOf('const verificationAndActivation = Effect.gen('));
  const verification = phase.indexOf("yield* runAppScript('scripts/verify-application-db-schema.mts', [");
  const activation = phase.indexOf('return yield* activateAccessRelease;');
  expect(verification).toBeGreaterThan(-1);
  expect(activation).toBeGreaterThan(verification);
  // Serial: nothing runs the activation beside the schema check, and no partial verification exists.
  expect(phase.slice(0, activation)).not.toContain('Effect.all(');
  expect(migrator).not.toContain('--part');
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
  expect(migrator).toContain('OwnerMigrationPlannerLive(appDirectory).pipe(Layer.provide(Reactivity.layer))');
  expect(migrator).toContain('NodeRuntime.runMain(main.pipe(Effect.provide(MigratorLive))');
});
