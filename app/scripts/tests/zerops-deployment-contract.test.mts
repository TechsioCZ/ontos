import { readFileSync } from 'node:fs';

import { expect, it } from 'effect-rstest';

const runtimeDatabaseUrl = `DATABASE_URL: postgresql://ontos_runtime:\${db18_password}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`;
const zeropsManifestUrl = new URL('../../zerops.yaml', import.meta.url);

const serviceBlock = (zeropsYaml: string, setup: string): string => {
  const start = zeropsYaml.indexOf(`  - setup: '${setup}'`);
  const end = zeropsYaml.indexOf('\n  - setup:', start + 1);

  expect(start).toBeGreaterThanOrEqual(0);
  return zeropsYaml.slice(start, end === -1 ? undefined : end);
};

it('binds generated PostgreSQL credentials into every database-using service', () => {
  const zeropsYaml = readFileSync(zeropsManifestUrl, 'utf-8');

  for (const setup of [
    'migrator',
    'party-registry',
    'commerce-customer-context',
    'payment-term-catalog',
    'price-group-catalog',
    'price-group-catalog-worker',
    'shellsuperapp',
  ]) {
    expect(serviceBlock(zeropsYaml, setup)).toContain(runtimeDatabaseUrl);
  }
});

it('binds the SpiceDB datastore URL into the migrator environment', () => {
  const zeropsYaml = readFileSync(zeropsManifestUrl, 'utf-8');
  const migrator = serviceBlock(zeropsYaml, 'migrator');

  expect(migrator).toContain(`SPICEDB_DATABASE_URL: \${spicedb_SPICEDB_DATASTORE_CONN_URI}`);
});

it('binds Commerce to the independently deployed Price Group Catalog API base', () => {
  const zeropsYaml = readFileSync(zeropsManifestUrl, 'utf-8');
  const commerce = serviceBlock(zeropsYaml, 'commerce-customer-context');
  const priceGroupCatalog = serviceBlock(zeropsYaml, 'price-group-catalog');

  expect(commerce).toContain(
    `ONTOS_PRICE_GROUP_CATALOG_BASE_URL: 'http://price-group-catalog:4104/price-group-catalog-api'`,
  );
  expect(priceGroupCatalog).toContain(`VERTICAL_PRICE_GROUP_CATALOG_PORT: '4104'`);
  expect(priceGroupCatalog).toContain(`path: '/price-group-catalog-api/price-group-catalog/readiness'`);
});

it('declares Price Group deployment variables for Cloudflare proof and stage promotion', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url),
    'utf-8',
  );

  expect(workflow).toContain('ULTRAMODERN_PUBLIC_URL_PRICE_GROUP_CATALOG: https://price-group-catalog.invalid');
  expect(workflow).toContain(
    `ZEROPS_PRICE_GROUP_CATALOG_SERVICE_ID: \${{ vars.ZEROPS_PRICE_GROUP_CATALOG_SERVICE_ID }}`,
  );
});

it('starts a dedicated Price Group worker that drains durable pending projections after restart', () => {
  const zeropsYaml = readFileSync(zeropsManifestUrl, 'utf-8');
  const worker = serviceBlock(zeropsYaml, 'price-group-catalog-worker');

  expect(worker).toContain(
    `zerops:materialize --app 'price-group-catalog' --package '@app/price-group-catalog' --package-dir 'verticals/price-group-catalog' --worker`,
  );
  expect(worker).toContain(`OUTBOX_WORKER_HEALTH_PORT: '4104'`);
  expect(worker).toContain(`path: '/ready'`);
  expect(worker).toContain(`exec npm run serve`);
});
