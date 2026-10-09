import { readFileSync } from 'node:fs';

import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import {
  DEPLOYMENT_ENVIRONMENT_VARIABLE,
  materializeZeropsEnvironment,
  SPICEDB_ENDPOINT_VARIABLE,
} from '../materialize-zerops-environment.mts';
import { OUTBOX_WORKER_HOST } from '../outbox-worker-delivery.mjs';

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
const DeployJobSchema = Schema.Struct({
  steps: Schema.Array(
    Schema.Struct({
      'continue-on-error': Schema.optional(Schema.Boolean),
      name: Schema.String,
      run: Schema.optional(Schema.String),
    }),
  ),
});
const DeployWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'deploy-migrations': DeployJobSchema,
    'deploy-plan': DeployJobSchema,
    'deploy-zerops': DeployJobSchema,
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

it('binds the SpiceDB datastore password, never a URL, into the migrator and SpiceDB services', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const migrator = serviceBlock(zeropsYaml, 'migrator');
  const spicedb = serviceBlock(zeropsYaml, 'spicedb');

  expect(migrator).toContain(`SPICEDB_DATABASE_PASSWORD: \${spicedb_SPICEDB_DATABASE_PASSWORD}`);
  expect(spicedb).toContain(`SPICEDB_DATABASE_HOST: \${db18_hostname}`);
  expect(spicedb).toContain(`SPICEDB_DATABASE_PORT: \${db18_port}`);
  expect(spicedb).toContain(`- 'app/scripts/spicedb-datastore-uri.sh'`);
  expect(zeropsYaml).not.toContain('SPICEDB_DATASTORE_CONN_URI');
  expect(zeropsYaml).not.toContain('SPICEDB_DATABASE_URL');
});

it('inherits a stable composition source without coupling service startup to publication', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const customerContext = serviceBlock(zeropsYaml, commerceCustomerContextSetup);

  expect(zeropsYaml).toContain('ONTOS_ACTIVE_APPLICATION_COMPOSITION_URL');
  expect(zeropsYaml).toContain('ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN');
  expect(customerContext).toContain("start: sh -c 'cd app/.zerops/runtime/commerce-customer-context");
  expect(zeropsYaml).not.toContain('ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON');
  expect(customerContext).not.toContain('test -n');
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
  expect(workflow).toContain('app/scripts/push-zerops-units.sh');
  const pushUnits = readFileSync(new URL('../push-zerops-units.sh', import.meta.url), 'utf-8');
  expect(pushUnits).toContain('active-composition:publish stage-service-id --setup "$unit"');
  // Neither dedicated workers nor the combined host may be given a public subdomain.
  expect(pushUnits).toContain(`    *-worker | ${OUTBOX_WORKER_HOST.stageSetup}) ;;`);
  const providerVariables = workflow.match(/^ +ZEROPS_[A-Z_]+_SERVICE_ID: /gmu)?.map((line) => line.trim()) ?? [];
  expect(providerVariables).toEqual([
    'ZEROPS_MIGRATOR_SERVICE_ID:',
    'ZEROPS_SPICEDB_SERVICE_ID:',
    'ZEROPS_SHELL_SERVICE_ID:',
  ]);
});

it("stops the other Outbox Worker mode's workers after this mode's workers deploy", () => {
  const workflow = Schema.decodeUnknownSync(DeployWorkflowSchema)(parse(readFileSync(workflowPath, 'utf-8')));
  const deployZerops = workflow.jobs['deploy-zerops'];
  const deployPlan = workflow.jobs['deploy-plan'];
  const steps = deployPlan.steps.map((step) => step.name);
  const stop = deployZerops.steps.find((step) => step.name === "Stop the other Outbox Worker mode's workers");

  expect(stop?.run).toContain('active-composition:publish stop-service --setup "$setup"');
  // A mode switch changes no source, so running workers of the other mode make the plan reconcile.
  const drift = deployPlan.steps.find(
    (step) => step.name === 'Detect Outbox Workers that do not match the Outbox Worker mode',
  );
  expect(drift?.run).toContain('active-composition:publish worker-mode-drift');
  expect(steps.indexOf('Detect Outbox Workers that do not match the Outbox Worker mode')).toBeLessThan(
    steps.indexOf('Generate topology-driven deployment impact plan'),
  );
  const plan = deployPlan.steps.find((step) => step.name === 'Generate topology-driven deployment impact plan');
  expect(plan?.run).toContain('plan_arguments+=(--reconcile-workers)');
  const deploySteps = deployZerops.steps.map((step) => step.name);
  expect(deploySteps.indexOf('Publish the complete active Application Composition')).toBeGreaterThanOrEqual(0);
  expect(deploySteps.indexOf("Stop the other Outbox Worker mode's workers")).toBeGreaterThan(
    deploySteps.indexOf('Publish the complete active Application Composition'),
  );
});

it('declares the Inventory public URL for Cloudflare proof', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url),
    'utf-8',
  );

  expect(workflow).toContain('ULTRAMODERN_PUBLIC_URL_INVENTORY: https://inventory.invalid');
});

it('starts a dedicated Price Group worker that drains durable pending projections after restart', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const worker = serviceBlock(zeropsYaml, 'price-group-catalog-worker');

  expect(worker).toContain(
    `zerops:materialize --app '${priceGroupCatalogSetup}' --package '@app/price-group-catalog' --package-dir 'verticals/price-group-catalog' --worker`,
  );
  expect(worker).toContain(`OUTBOX_WORKER_HEALTH_PORT: '4108'`);
  expect(worker).toContain(runtimeDatabaseUrl);
  expect(worker).toContain(`path: '/live'`);
  expect(worker).toContain(`exec node worker.mjs`);
  expect(worker).not.toContain('npm run serve');
});

it('runs every owner worker in one Outbox Worker host service beside the dedicated workers', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const host = serviceBlock(zeropsYaml, 'outbox-worker-host');

  expect(host).toContain(`zerops:materialize --app 'outbox-worker-host' --package 'app' --package-dir '.' --worker`);
  expect(host).toContain(`- 'app/.zerops/runtime/outbox-worker-host'`);
  expect(host).toContain(`OUTBOX_WORKER_HEALTH_PORT: '4100'`);
  expect(host).toContain(runtimeDatabaseUrl);
  // Commerce's worker reaches Price Group Catalog, so the host carries its binding too.
  expect(host).toContain(`ONTOS_PRICE_GROUP_CATALOG_BASE_URL: 'http://pricegroupcatalog:4108/price-group-catalog-api'`);
  expect(host).toContain("start: sh -c 'cd app/.zerops/runtime/outbox-worker-host");
  expect(host.match(/path: '\/live'/gu)).toHaveLength(2);
  // The dedicated Outbox Worker mode keeps deploying each owner's own worker.
  for (const worker of ['party-registry-worker', 'commerce-customer-context-worker', 'price-group-catalog-worker']) {
    expect(serviceBlock(zeropsYaml, worker)).toContain('--worker');
  }
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

it('fails every app build whose Zephyr upload fails', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const appBuilds = zeropsYaml.split(/(?=^ {2}- setup:)/mu).filter((block) => / run build$/mu.test(block));

  expect(appBuilds.length).toBeGreaterThan(8);
  for (const block of appBuilds) {
    expect(block).toMatch(/^ {4}build:\n(?: {6}.*\n)*? {6}envVariables:\n(?: {8}.*\n)*? {8}ZE_FAIL_BUILD: 'true'\n/mu);
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
// Units that serve no public route: the migrator, the Outbox Worker host and the Cloudflare Tunnel connector.
const PRIVATE_SETUPS = new Set(['cloudflared', 'migrator', 'outbox-worker-host']);
const INFRASTRUCTURE_HOSTNAMES = new Set(['db18', 'spicedb']);

const hostnameOf = (setup: string) =>
  setup === 'commerce-customer-context-worker' ? 'commercecstmrcntxtworker' : setup.replaceAll('-', '');

it('declares a public subdomain at service creation for every non-worker unit and never for a worker', () => {
  const units = Schema.decodeUnknownSync(ZeropsYamlSchema)(parse(readFileSync(zeropsYamlPath, 'utf-8'))).zerops.filter(
    ({ setup }) => setup !== 'spicedb',
  );
  const { services: declared } = Schema.decodeUnknownSync(ZeropsImportSchema)(
    parse(readFileSync(new URL('../../zerops-import.yaml', import.meta.url), 'utf-8')),
  );
  // The shared data plane: PostgreSQL has no unit, and SpiceDB's Docker VM runs the image its unit pins.
  expect(
    declared
      .filter(({ hostname }) => INFRASTRUCTURE_HOSTNAMES.has(hostname))
      .map(
        ({ enableSubdomainAccess = false, hostname, type }) => `${hostname} ${type} ${String(enableSubdomainAccess)}`,
      ),
  ).toStrictEqual(['db18 postgresql:single@18 false', 'spicedb docker@26.1.5 false']);
  const services = declared.filter(({ hostname }) => !INFRASTRUCTURE_HOSTNAMES.has(hostname));
  expect(services).toHaveLength(units.length);
  expect(
    new Set(
      services.map(
        ({ enableSubdomainAccess = false, hostname, type }) => `${hostname} ${type} ${String(enableSubdomainAccess)}`,
      ),
    ),
  ).toEqual(
    new Set(
      units.map(
        ({ run, setup }) =>
          `${hostnameOf(setup)} ${run.base} ${String(!setup.endsWith('-worker') && !PRIVATE_SETUPS.has(setup))}`,
      ),
    ),
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
  const { jobs } = Schema.decodeUnknownSync(DeployWorkflowSchema)(parse(readFileSync(workflowPath, 'utf-8')));

  for (const step of [
    ...jobs['deploy-plan'].steps,
    ...jobs['deploy-migrations'].steps,
    ...jobs['deploy-zerops'].steps,
  ]) {
    const run = step.run ?? '';
    expect(run).not.toContain('enable-subdomain');
    expect(run.replaceAll(/zcli service log[^|]*\|\| true/gu, '')).not.toContain('|| true');
    if (step['continue-on-error'] === true) {
      expect(run).toMatch(/^zcli service log /u);
    }
  }
});

it('keeps module origins out of the Shell build so new approved modules require no Shell deployment', () => {
  const shellBlock = serviceBlock(readFileSync(zeropsYamlPath, 'utf-8'), 'shellsuperapp');
  const shellBuild = shellBlock.slice(0, shellBlock.indexOf('\n    deploy:'));
  expect(shellBuild).not.toContain('ULTRAMODERN_PUBLIC_URL_');
  expect(shellBuild).not.toContain('_zeropsSubdomain');
});

it.effect('pushes every Zerops setup with the deploying environment named in its builds and runtimes', () =>
  Effect.gen(function* materializedEnvironment() {
    const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
    const stageLine = `${DEPLOYMENT_ENVIRONMENT_VARIABLE}: stage`;
    const stageCount = zeropsYaml.split(stageLine).length - 1;
    expect(stageCount).toBeGreaterThan(0);
    // The committed file is stage's, byte for byte.
    expect(yield* materializeZeropsEnvironment(zeropsYaml, { environment: 'stage' })).toBe(zeropsYaml);
    // Production names itself and reaches its TLS SpiceDB endpoint, and changes nothing else.
    const productionEndpoint = 'spicedb.production.example:443';
    const production = yield* materializeZeropsEnvironment(zeropsYaml, {
      environment: 'production',
      spiceDbEndpoint: productionEndpoint,
    });
    const stageEndpointLine = `${SPICEDB_ENDPOINT_VARIABLE}: 'spicedb:50051'`;
    const productionEndpointLine = `${SPICEDB_ENDPOINT_VARIABLE}: '${productionEndpoint}'`;
    const certificateLine = `SPICEDB_CA_CERT: \${spicedb_SPICEDB_GRPC_TLS_CERT}`;
    expect(production.includes(stageLine)).toBe(false);
    expect(production.includes(stageEndpointLine)).toBe(false);
    // Every runtime keeps pinning the gRPC certificate; nothing reaches SpiceDB in plaintext.
    expect(production.split(certificateLine).length - 1).toBe(zeropsYaml.split(stageEndpointLine).length - 1);
    expect(production.includes('SPICEDB_INSECURE')).toBe(false);
    expect(production.split(`${DEPLOYMENT_ENVIRONMENT_VARIABLE}: production`).length - 1).toBe(stageCount);
    expect(production.split(productionEndpointLine).length - 1).toBe(zeropsYaml.split(stageEndpointLine).length - 1);
    expect(
      production
        .replaceAll(`${DEPLOYMENT_ENVIRONMENT_VARIABLE}: production`, stageLine)
        .replaceAll(productionEndpointLine, stageEndpointLine),
    ).toBe(zeropsYaml);
    const missing = yield* Effect.flip(
      materializeZeropsEnvironment('zerops:\n  - setup: api\n', { environment: 'stage' }),
    );
    expect(missing.message).toContain(DEPLOYMENT_ENVIRONMENT_VARIABLE);
    const schemeEndpoint = yield* Effect.flip(
      materializeZeropsEnvironment(zeropsYaml, { environment: 'production', spiceDbEndpoint: 'https://spicedb:443' }),
    );
    expect(schemeEndpoint.message).toContain('host:port');

    const workflow = readFileSync(workflowPath, 'utf-8');
    expect(workflow).not.toContain('--zerops-yaml-path app/zerops.yaml');
    expect(workflow).toContain('zerops:materialize-environment');
    expect(workflow).toContain('--environment "$DEPLOY_ENVIRONMENT"');
    expect(workflow).toContain('--spicedb-endpoint "$PRODUCTION_SPICEDB_ENDPOINT"');
    const pushUnits = readFileSync(new URL('../push-zerops-units.sh', import.meta.url), 'utf-8');
    expect(pushUnits).toContain('--zerops-yaml-path "$ZEROPS_YAML_PATH"');
  }),
);
