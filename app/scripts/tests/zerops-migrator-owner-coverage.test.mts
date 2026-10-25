import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

const migrator = readFileSync(new URL('../run-zerops-migrator.mjs', import.meta.url), 'utf-8');
const deployment = readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8');
const [migratorDeployment] = deployment.split("  - setup: 'spicedb'");

for (const owner of [
  'price-group-catalog',
  'assortment',
  'commerce-market-catalog',
  'pricing',
  'privacy',
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
    expect(migratorDeployment).toContain(`- 'app/verticals/${owner}'`);
  });
}
