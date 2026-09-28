import { readFileSync } from 'node:fs';

import { expect, it } from '@rstest/core';

const migrator = readFileSync(new URL('../run-zerops-migrator.mjs', import.meta.url), 'utf8');
const deployment = readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf8');
const migratorDeployment = deployment.split("  - setup: 'spicedb'")[0];

for (const owner of ['price-group-catalog', 'commerce-market-catalog', 'pricing', 'storefront-registry']) {
  it(`D1 migrates and packages ${owner} before claiming database readiness`, () => {
    const migration = migrator.indexOf(`yield* migrate('verticals/${owner}', 'drizzle.config.ts');`);
    const verification = migrator.indexOf("'scripts/verify-application-db-schema.mts'");
    expect(migration).toBeGreaterThan(-1);
    expect(verification).toBeGreaterThan(migration);
    expect(migratorDeployment).toContain(`- 'app/verticals/${owner}'`);
  });
}
