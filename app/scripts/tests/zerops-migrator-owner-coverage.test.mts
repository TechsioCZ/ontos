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
const migratorDeployment = deployment.zerops.find((service) => service.setup === 'migrator');

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
]) {
  it(`D1 migrates and packages ${owner} before claiming database readiness`, () => {
    const migration = migrator.indexOf(`yield* migrate('verticals/${owner}', 'drizzle.config.ts');`);
    const verification = migrator.indexOf("'scripts/verify-application-db-schema.mts'");
    expect(migration).toBeGreaterThan(-1);
    expect(verification).toBeGreaterThan(migration);
    expect(migratorDeployment?.build?.deployFiles).toContain(`app/verticals/${owner}`);
  });
}
