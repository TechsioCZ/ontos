import { readFileSync } from 'node:fs';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const runtimeDatabaseUrl = `DATABASE_URL: postgresql://ontos_runtime:\${db18_password}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`;
const commerceCustomerContextSetup = 'commerce-customer-context';
const priceGroupCatalogSetup = 'price-group-catalog';
const zeropsYamlPath = new URL('../../zerops.yaml', import.meta.url);
const workflowPath = new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url);

const ZeropsYamlSchema = Schema.Struct({
  zerops: Schema.Array(Schema.Struct({ run: Schema.Struct({ base: Schema.String }), setup: Schema.String })),
});
const ZeropsImportSchema = Schema.Struct({
  services: Schema.Array(
    Schema.Struct({
      enableSubdomainAccess: Schema.optional(Schema.Boolean),
      hostname: Schema.String,
      type: Schema.String,
    }),
  ),
});
const DeployWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'deploy-stage': Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          'continue-on-error': Schema.optional(Schema.Boolean),
          name: Schema.String,
          run: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
});

const serviceBlock = (zeropsYaml: string, setup: string): string => {
  const start = zeropsYaml.indexOf(`  - setup: '${setup}'`);
  const end = zeropsYaml.indexOf('\n  - setup:', start + 1);

  expect(start).toBeGreaterThanOrEqual(0);
  return zeropsYaml.slice(start, end === -1 ? undefined : end);
};

it('binds generated PostgreSQL credentials into every database-using service', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');

  for (const setup of [
    'migrator',
    'party-registry',
    commerceCustomerContextSetup,
    'payment-term-catalog',
    priceGroupCatalogSetup,
    'commerce-market-catalog',
    'catalog',
    'pricing',
    'storefront-registry',
    'shellsuperapp',
  ]) {
    expect(serviceBlock(zeropsYaml, setup)).toContain(runtimeDatabaseUrl);
  }
});

it('binds the SpiceDB datastore URL into the migrator environment', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const migrator = serviceBlock(zeropsYaml, 'migrator');

  expect(migrator).toContain(`SPICEDB_DATABASE_URL: \${spicedb_SPICEDB_DATASTORE_CONN_URI}`);
});

it('requires the inherited active composition snapshot for Customer Context without shadowing it', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const customerContext = serviceBlock(zeropsYaml, commerceCustomerContextSetup);

  expect(customerContext).toContain('test -n "$ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON"');
  expect(customerContext).not.toContain('ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON:');
});

it('binds Commerce to the independently deployed Price Group Catalog API base', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const commerce = serviceBlock(zeropsYaml, commerceCustomerContextSetup);
  const priceGroupCatalog = serviceBlock(zeropsYaml, priceGroupCatalogSetup);

  expect(commerce).toContain(
    `ONTOS_PRICE_GROUP_CATALOG_BASE_URL: 'http://pricegroupcatalog:4108/price-group-catalog-api'`,
  );
  expect(priceGroupCatalog).toContain(`VERTICAL_PRICE_GROUP_CATALOG_PORT: '4108'`);
  expect(priceGroupCatalog).toContain(`path: '/price-group-catalog-api/price-group-catalog/readiness'`);
});

it('declares Price Group Cloudflare proof variables and resolves every provider service id by topology name', () => {
  const workflow = readFileSync(workflowPath, 'utf-8');

  expect(workflow).toContain('ULTRAMODERN_PUBLIC_URL_PRICE_GROUP_CATALOG: https://price-group-catalog.invalid');
  expect(workflow).toContain(`STAGE_VARIABLES_JSON: \${{ toJSON(vars) }}`);
  expect(workflow).toContain(`jq -r --arg key "$environment_key" '.[$key] // empty' <<<"$STAGE_VARIABLES_JSON"`);
  const providerVariables = workflow.match(/^ +ZEROPS_[A-Z_]+_SERVICE_ID: /gmu)?.map((line) => line.trim()) ?? [];
  expect(providerVariables).toEqual([
    'ZEROPS_MIGRATOR_SERVICE_ID:',
    'ZEROPS_SHELL_SERVICE_ID:',
    'ZEROPS_SPICEDB_SERVICE_ID:',
  ]);
});

it('starts a dedicated Price Group worker that drains durable pending projections after restart', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const worker = serviceBlock(zeropsYaml, 'price-group-catalog-worker');

  expect(worker).toContain(
    `zerops:materialize --app '${priceGroupCatalogSetup}' --package '@app/price-group-catalog' --package-dir 'verticals/price-group-catalog' --worker`,
  );
  expect(worker).toContain(`OUTBOX_WORKER_HEALTH_PORT: '4108'`);
  expect(worker).toContain(`DATABASE_URL: \${pricegroupcatalog_DATABASE_URL}`);
  expect(worker).toContain(`path: '/ready'`);
  expect(worker).toContain(`exec npm run serve`);
});

it('builds every Node service with the pinned toolchain and ships Node instead of downloading it at start', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const node = /^node = "(?<node>[^"]+)"$/mu.exec(readFileSync(new URL('../../.mise.toml', import.meta.url), 'utf-8'))
    ?.groups?.node;
  const pnpm = /"packageManager": "pnpm@(?<pnpm>[^"+]+)"/u.exec(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
  )?.groups?.pnpm;
  const nodeServices = zeropsYaml
    .split(/(?=^ {2}- setup:)/mu)
    .filter((block) => block.includes('install-zerops-node.sh'));

  expect(nodeServices.length).toBeGreaterThan(10);
  for (const block of nodeServices) {
    expect(block).toContain(`install-zerops-node.sh ${node} ${pnpm}\n`);
    expect(block).toContain(`cp -a "$HOME/.local/node-${node}/bin" "$HOME/.local/node-${node}/lib" `);
    expect(block).toContain('node scripts/verify-zerops-workspace-install.mts');
    expect(block).toMatch(/start: sh -c '.*PATH="\$PWD\/[^"]*node\/bin:\$PATH" exec /u);
    expect(block).not.toContain('initCommands');
    expect(block).not.toMatch(/virtual-store|VIRTUAL_STORE|--force|reset-workspace-dependencies/u);
  }
});

it('ships every package the migrator runs drizzle-kit in', () => {
  const migrator = serviceBlock(readFileSync(zeropsYamlPath, 'utf-8'), 'migrator');
  const runner = readFileSync(new URL('../run-zerops-migrator.mjs', import.meta.url), 'utf-8');
  const migratedPackages = [...runner.matchAll(/migrate\('(?<directory>[^']+)'/gu)].map(
    (match) => match.groups?.directory ?? '',
  );

  expect(migratedPackages).toContain('verticals/catalog');
  for (const directory of new Set(migratedPackages)) {
    expect(migrator).toMatch(new RegExp(`^ +- 'app/(?:${directory}|${directory.split('/')[0]})'$`, 'mu'));
  }
});

// Zerops caps hostnames at 25 characters, so stage runs this worker under an abbreviated name.
const hostnameOf = (setup: string) =>
  setup === 'commerce-customer-context-worker' ? 'commercecstmrcntxtworker' : setup.replaceAll('-', '');

it('declares a public subdomain at service creation for every non-worker unit and never for a worker', () => {
  const units = Schema.decodeUnknownSync(ZeropsYamlSchema)(parse(readFileSync(zeropsYamlPath, 'utf-8'))).zerops.filter(
    ({ setup }) => setup !== 'migrator' && setup !== 'spicedb',
  );
  const { services } = Schema.decodeUnknownSync(ZeropsImportSchema)(
    parse(readFileSync(new URL('../../zerops-import.yaml', import.meta.url), 'utf-8')),
  );
  expect(services).toHaveLength(units.length);
  expect(
    new Set(
      services.map(
        ({ enableSubdomainAccess = false, hostname, type }) => `${hostname} ${type} ${String(enableSubdomainAccess)}`,
      ),
    ),
  ).toEqual(
    new Set(units.map(({ run, setup }) => `${hostnameOf(setup)} ${run.base} ${String(!setup.endsWith('-worker'))}`)),
  );
  for (const service of services) {
    expect(service.hostname).toMatch(/^[a-z0-9]{1,25}$/u);
  }
  // Services reach each other by Zerops hostname, which never contains a hyphen.
  const hostnames = new Set(services.map(({ hostname }) => hostname));
  for (const [, host] of readFileSync(zeropsYamlPath, 'utf-8').matchAll(/http:\/\/(?<host>[^/:']+):/gu)) {
    expect(hostnames).toContain(host);
  }
});

it('lets stage deploy failures fail the job, tolerating only best-effort log collection', () => {
  const { steps } = Schema.decodeUnknownSync(DeployWorkflowSchema)(parse(readFileSync(workflowPath, 'utf-8'))).jobs[
    'deploy-stage'
  ];

  for (const step of steps) {
    const run = step.run ?? '';
    expect(run).not.toContain('enable-subdomain');
    expect(run.replaceAll(/zcli service log[^|]*\|\| true/gu, '')).not.toContain('|| true');
    if (step['continue-on-error'] === true) {
      expect(run).toMatch(/^zcli service log /u);
    }
  }
});
