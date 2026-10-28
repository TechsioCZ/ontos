import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { isMap, isScalar, isSeq, parse, parseDocument, YAMLMap, YAMLSeq } from 'yaml';

import { readZeropsDeployment } from '../generate-zerops-provider-deployment.mts';

import {
  DEPLOYMENT_ENVIRONMENT_VARIABLE,
  materializeZeropsEnvironment,
  SPICEDB_ENDPOINT_VARIABLE,
} from '../materialize-zerops-environment.mts';
import { OUTBOX_WORKER_HOST } from '../outbox-worker-delivery.mjs';

const runtimeDatabaseUrl = `DATABASE_URL: postgresql://ontos_runtime:\${db18_password}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`;
const commerceCustomerContextSetup = 'commerce-customer-context';
const priceGroupCatalogSetup = 'price-group-catalog';
const PARTY_REGISTRY_WORKER_SETUP = 'party-registry-worker';
const priceGroupWorkerSetup = 'price-group-catalog-worker';
const partyRegistrySetup = 'party-registry';
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

const zeropsImportPath = new URL('../../zerops-import.yaml', import.meta.url);
const ServiceEnvironmentSchema = Schema.Struct({
  zerops: Schema.Array(
    Schema.Struct({
      run: Schema.Struct({ envVariables: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
      setup: Schema.String,
    }),
  ),
});
const DATABASE_URL_KEYS = [
  'DATABASE_URL',
  'PARTY_REGISTRY_DATABASE_URL',
  'PARTY_REGISTRY_WORKER_DATABASE_URL',
  'SHELL_GATEWAY_ISSUER_DATABASE_URL',
];
const identityUrl = (role: string, password: string) =>
  `postgresql://${role}:\${${password}}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`;

const serviceEnvironments = (): ReadonlyMap<string, Readonly<Record<string, string>>> =>
  new Map(
    Schema.decodeUnknownSync(ServiceEnvironmentSchema)(parse(readFileSync(zeropsYamlPath, 'utf-8'))).zerops.map(
      ({ run, setup }) => [setup, run.envVariables ?? {}],
    ),
  );

const databaseUrlKeys = (environment: Readonly<Record<string, string>>) =>
  DATABASE_URL_KEYS.filter((key) => environment[key] !== undefined);

const pushUnitsPath = new URL('../push-zerops-units.sh', import.meta.url);

const serviceNode = (zeropsYaml: string, setup: string) => {
  const services = Schema.decodeUnknownSync(Schema.instanceOf(YAMLSeq))(parseDocument(zeropsYaml).get('zerops', true));
  const matches = services.items.filter((item) => isMap(item) && item.get('setup') === setup);
  expect(matches).toHaveLength(1);
  return Schema.decodeUnknownSync(Schema.instanceOf(YAMLMap))(matches[0]);
};

const serviceStrings = (service: YAMLMap, keys: readonly string[]): readonly string[] => {
  const sequence = service.getIn(keys, true);
  if (sequence === undefined) {
    return [];
  }
  const values = isSeq(sequence) ? sequence.items.map((item) => (isScalar(item) ? item.value : item)) : sequence;
  return Schema.decodeUnknownSync(Schema.Array(Schema.String))(values);
};

const serviceBlock = (zeropsYaml: string, setup: string): string => {
  const { range } = Schema.decodeUnknownSync(
    Schema.Struct({ range: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]) }),
  )(serviceNode(zeropsYaml, setup));
  return zeropsYaml.slice(range[0], range[1]);
};

const expectPriceGroupBinding = (service: YAMLMap): void => {
  const binding = Schema.decodeUnknownSync(Schema.String)(
    service.getIn(['run', 'envVariables', 'ONTOS_PRICE_GROUP_CATALOG_BASE_URL']),
  );
  // This provider address is internal to Zerops, not a public clear-text endpoint.
  expect(new URL(binding)).toMatchObject({
    hostname: 'pricegroupcatalog',
    pathname: '/price-group-catalog-api',
    port: '4108',
    protocol: 'http:',
  });
};

it('binds generated PostgreSQL credentials into every database-using service', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');

  for (const setup of [
    'migrator',
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
  expect(serviceStrings(serviceNode(zeropsYaml, 'spicedb'), ['build', 'deployFiles'])).toContain(
    'app/scripts/spicedb-datastore-uri.sh',
  );
  expect(zeropsYaml).not.toContain('SPICEDB_DATASTORE_CONN_URI');
  expect(zeropsYaml).not.toContain('SPICEDB_DATABASE_URL');
});

it('inherits a stable composition source without coupling service startup to publication', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const customerContext = serviceBlock(zeropsYaml, commerceCustomerContextSetup);

  const sourceConfiguration = readFileSync(
    new URL('../configure-runtime-composition-source.mts', import.meta.url),
    'utf-8',
  );
  const publication = readFileSync(new URL('../publish-active-application-composition.mts', import.meta.url), 'utf-8');
  expect(sourceConfiguration).toContain('ACTIVE_APPLICATION_COMPOSITION_POLICY.sourceUrlVariable');
  expect(sourceConfiguration).toContain('ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN');
  expect(sourceConfiguration).toContain('api.upsertProjectEnv(');
  expect(publication).toContain("Command.make('configure-source'");
  expect(publication).toContain('yield* configureRuntimeCompositionSource({ projectId, readToken, url })');
  expect(customerContext).toContain("start: sh -c 'cd app/.zerops/runtime/commerce-customer-context");
  expect(zeropsYaml).not.toContain('ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON');
  expect(customerContext).not.toContain('test -n');
});

it('binds Commerce to the independently deployed Price Group Catalog API base', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');

  expectPriceGroupBinding(serviceNode(zeropsYaml, commerceCustomerContextSetup));
  expect(
    serviceNode(zeropsYaml, priceGroupCatalogSetup).getIn(['run', 'envVariables', 'VERTICAL_PRICE_GROUP_CATALOG_PORT']),
  ).toBe('4108');
  expect(serviceNode(zeropsYaml, priceGroupCatalogSetup).getIn(['run', 'healthCheck', 'httpGet', 'path'])).toBe(
    '/price-group-catalog-api/price-group-catalog/readiness',
  );
});

it('declares Price Group Cloudflare proof variables and resolves every provider service id by topology name', () => {
  const workflow = readFileSync(workflowPath, 'utf-8');

  expect(workflow).toContain('ULTRAMODERN_PUBLIC_URL_PRICE_GROUP_CATALOG: https://price-group-catalog.invalid');
  expect(workflow).toContain(`STAGE_VARIABLES_JSON: \${{ toJSON(vars) }}`);
  expect(workflow).toContain('app/scripts/push-zerops-units.sh');
  const pushUnits = readFileSync(pushUnitsPath, 'utf-8');
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
  const worker = serviceBlock(zeropsYaml, priceGroupWorkerSetup);

  expect(worker).toContain(
    `zerops:materialize --app '${priceGroupCatalogSetup}' --package '@app/price-group-catalog' --package-dir 'verticals/price-group-catalog' --worker`,
  );
  expect(
    serviceNode(zeropsYaml, priceGroupWorkerSetup).getIn(['run', 'envVariables', 'OUTBOX_WORKER_HEALTH_PORT']),
  ).toBe('4108');
  expect(worker).toContain(runtimeDatabaseUrl);
  expect(serviceNode(zeropsYaml, priceGroupWorkerSetup).getIn(['run', 'healthCheck', 'httpGet', 'path'])).toBe('/live');
  expect(worker).toContain(`exec node worker.mjs`);
  expect(worker).not.toContain('npm run serve');
});

it('runs every owner worker in one Outbox Worker host service beside the dedicated workers', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const host = serviceBlock(zeropsYaml, OUTBOX_WORKER_HOST.id);

  // CI prebuilds the host (scripts/ci/build-outbox-host.sh) and Zerops only deploys it: no Zerops build.
  expect(serviceNode(zeropsYaml, OUTBOX_WORKER_HOST.id).has('build')).toBe(false);
  expect(host).not.toContain('zerops:materialize');
  const pushUnits = readFileSync(pushUnitsPath, 'utf-8');
  expect(pushUnits).toContain('zcli service deploy');
  expect(pushUnits).toContain(`readonly host_runtime="app/.zerops/runtime/$host_setup"`);
  expect(
    serviceNode(zeropsYaml, OUTBOX_WORKER_HOST.id).getIn(['run', 'envVariables', 'OUTBOX_WORKER_HEALTH_PORT']),
  ).toBe('4100');
  expect(host).toContain(runtimeDatabaseUrl);
  // Commerce's worker reaches Price Group Catalog, so the host carries its binding too.
  expectPriceGroupBinding(serviceNode(zeropsYaml, OUTBOX_WORKER_HOST.id));
  expect(host).toContain("start: sh -c 'cd app/.zerops/runtime/outbox-worker-host");
  for (const branch of [
    ['deploy', 'readinessCheck'],
    ['run', 'healthCheck'],
  ]) {
    expect(serviceNode(zeropsYaml, OUTBOX_WORKER_HOST.id).getIn([...branch, 'httpGet', 'path'])).toBe('/live');
  }
  // The dedicated Outbox Worker mode keeps deploying each owner's own worker.
  for (const worker of [PARTY_REGISTRY_WORKER_SETUP, 'commerce-customer-context-worker', priceGroupWorkerSetup]) {
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

it.effect('fails every app build whose Zephyr upload fails', () =>
  Effect.gen(function* zephyrBuildFailures() {
    const deployment = yield* readZeropsDeployment(readFileSync(zeropsYamlPath, 'utf-8'));
    const appBuilds = [...deployment.services.values()].filter((service) =>
      serviceStrings(service, ['build', 'buildCommands']).some((command) => command.endsWith(' run build')),
    );
    expect(appBuilds.length).toBeGreaterThan(8);
    for (const service of appBuilds) {
      expect(service.getIn(['build', 'envVariables', 'ZE_FAIL_BUILD'])).toBe('true');
    }
  }),
);

it('ships every package the migrator runs drizzle-kit in', () => {
  const source = readFileSync(zeropsYamlPath, 'utf-8');
  const migrator = serviceNode(source, 'migrator');
  const runner = readFileSync(new URL('../run-zerops-migrator.mjs', import.meta.url), 'utf-8');
  const migratedPackages = [...runner.matchAll(/migrate\('(?<directory>[^']+)'/gu)].map(
    (match) => match.groups?.directory ?? '',
  );
  if (runner.includes("yield* migrateConvergentOwner('core')")) {
    migratedPackages.push('packages/core-runtime');
  }
  if (runner.includes("yield* migrateConvergentOwner('party')")) {
    migratedPackages.push('verticals/party-registry');
  }
  const files = serviceStrings(migrator, ['build', 'deployFiles']);
  for (const required of ['app/database', 'app/packages', 'app/scripts']) {
    expect(files.filter((file) => file === required)).toHaveLength(1);
  }
  expect(migrator.get('setup')).toBe('migrator');
  expect(migratedPackages).toContain('verticals/catalog');
  for (const directory of new Set(migratedPackages)) {
    expect(files.some((file) => file === `app/${directory}` || file === `app/${directory.split('/')[0]}`)).toBe(true);
  }
});

// Zerops caps hostnames at 25 characters, so stage runs this worker under an abbreviated name.
// Units that serve no public route: the migrator, the Outbox Worker host and the Cloudflare Tunnel connector.
const PRIVATE_SETUPS = new Set(['cloudflared', 'migrator', OUTBOX_WORKER_HOST.id]);
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
  const shellBuild = JSON.stringify(serviceNode(readFileSync(zeropsYamlPath, 'utf-8'), 'shellsuperapp').get('build'));
  expect(shellBuild).not.toContain('ULTRAMODERN_PUBLIC_URL_');
  expect(shellBuild).not.toContain('_zeropsSubdomain');
});

it.effect('pushes every Zerops setup with the deploying environment named in its builds and runtimes', () =>
  Effect.gen(function* materializedEnvironment() {
    const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
    const source = parseDocument(zeropsYaml);
    const stage = yield* materializeZeropsEnvironment(zeropsYaml, { environment: 'stage' });
    expect(Schema.decodeUnknownSync(Schema.Unknown)(parse(stage))).toEqual(
      Schema.decodeUnknownSync(Schema.Unknown)(parse(zeropsYaml)),
    );
    const productionEndpoint = 'spicedb.production.example:443';
    const production = yield* materializeZeropsEnvironment(zeropsYaml, {
      environment: 'production',
      spiceDbEndpoint: productionEndpoint,
    });
    const actual = parseDocument(production);
    const { zerops } = Schema.decodeUnknownSync(ZeropsYamlSchema)(parse(zeropsYaml));
    let environmentCount = 0;
    let endpointCount = 0;
    for (const [index] of zerops.entries()) {
      for (const phase of ['build', 'run']) {
        const environment = ['zerops', index, phase, 'envVariables'];
        const target = [...environment, DEPLOYMENT_ENVIRONMENT_VARIABLE];
        if (source.hasIn(target)) {
          expect(source.getIn(target)).toBe('stage');
          expect(actual.getIn(target)).toBe('production');
          source.setIn(target, 'production');
          environmentCount += 1;
        }
        const endpoint = [...environment, SPICEDB_ENDPOINT_VARIABLE];
        if (source.hasIn(endpoint)) {
          expect(actual.getIn(endpoint)).toBe(productionEndpoint);
          expect(actual.getIn([...environment, 'SPICEDB_CA_CERT'])).toBe(
            source.getIn([...environment, 'SPICEDB_CA_CERT']),
          );
          expect(actual.hasIn([...environment, 'SPICEDB_INSECURE'])).toBe(false);
          source.setIn(endpoint, productionEndpoint);
          endpointCount += 1;
        }
      }
    }
    expect(environmentCount).toBeGreaterThan(0);
    expect(endpointCount).toBeGreaterThan(0);
    expect(Schema.decodeUnknownSync(Schema.Unknown)(actual.toJS())).toEqual(
      Schema.decodeUnknownSync(Schema.Unknown)(source.toJS()),
    );
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
    const pushUnits = readFileSync(pushUnitsPath, 'utf-8');
    expect(pushUnits).toContain('--zerops-yaml-path "$ZEROPS_YAML_PATH"');
  }),
);

it('keeps the full demo inventory and binds Party requests and workers to their separate migrator secrets', () => {
  const source = readFileSync(zeropsYamlPath, 'utf-8');
  const party = serviceBlock(source, partyRegistrySetup);
  expect(party).toContain(
    `PARTY_REGISTRY_DATABASE_URL: postgresql://party_registry_runtime:\${migrator_PARTY_REGISTRY_DB_PASSWORD}@`,
  );
  expect(party).not.toContain('        DATABASE_URL:');
  const worker = serviceBlock(source, 'party-registry-worker');
  expect(worker).toContain(
    `PARTY_REGISTRY_WORKER_DATABASE_URL: postgresql://party_registry_worker:\${migrator_PARTY_REGISTRY_WORKER_DB_PASSWORD}@`,
  );
  expect(worker).not.toContain('        DATABASE_URL:');
  expect(worker).not.toContain('        PARTY_REGISTRY_DATABASE_URL:');
  expect(serviceBlock(source, OUTBOX_WORKER_HOST.id)).toContain(
    'PARTY_REGISTRY_WORKER_DATABASE_URL: postgresql://party_registry_worker:',
  );
  expect(serviceBlock(source, OUTBOX_WORKER_HOST.id)).toContain(runtimeDatabaseUrl);
  const core = serviceBlock(source, 'core-system-worker');
  expect(core).toContain(runtimeDatabaseUrl);
  expect(core).not.toContain('PARTY_REGISTRY_WORKER_DATABASE_URL:');
  expect(serviceBlock(source, 'shellsuperapp')).toContain(
    `SHELL_GATEWAY_ISSUER_DATABASE_URL: postgresql://shell_gateway_issuer:\${migrator_SHELL_GATEWAY_ISSUER_DB_PASSWORD}@`,
  );
  const migrator = serviceBlock(source, 'migrator');
  for (const key of [
    'PARTY_REGISTRY_DB_PASSWORD',
    'PARTY_REGISTRY_WORKER_DB_PASSWORD',
    'SHELL_GATEWAY_ISSUER_DB_PASSWORD',
  ]) {
    expect(migrator).toContain(`\${${key}}`);
    expect(migrator).not.toContain(`\${migrator_${key}}`);
  }
  const topology = Schema.decodeUnknownSync(
    Schema.fromJsonString(
      Schema.Struct({
        verticals: Schema.Array(Schema.Struct({ id: Schema.String })),
      }),
    ),
  )(readFileSync(new URL('../../topology/reference-topology.json', import.meta.url), 'utf-8'));
  expect(topology.verticals.map(({ id }) => id)).toEqual(
    expect.arrayContaining(['projects', 'crm', 'finance-billing', 'crm-activities']),
  );
  for (const { id } of topology.verticals) {
    expect(serviceNode(source, id).get('setup')).toBe(id);
  }
});
it('connects Party Registry only as its dedicated request identity', () => {
  const party = serviceEnvironments().get(partyRegistrySetup) ?? {};

  expect(databaseUrlKeys(party)).toStrictEqual(['PARTY_REGISTRY_DATABASE_URL']);
  expect(party.PARTY_REGISTRY_DATABASE_URL).toBe(
    identityUrl('party_registry_runtime', 'migrator_PARTY_REGISTRY_DB_PASSWORD'),
  );
});

it('connects the Party Registry worker only as its worker identity and the host with both', () => {
  const environments = serviceEnvironments();
  const workerUrl = identityUrl('party_registry_worker', 'migrator_PARTY_REGISTRY_WORKER_DB_PASSWORD');

  expect(databaseUrlKeys(environments.get(PARTY_REGISTRY_WORKER_SETUP) ?? {})).toStrictEqual([
    'PARTY_REGISTRY_WORKER_DATABASE_URL',
  ]);
  expect(environments.get(PARTY_REGISTRY_WORKER_SETUP)?.PARTY_REGISTRY_WORKER_DATABASE_URL).toBe(workerUrl);
  const host = environments.get(OUTBOX_WORKER_HOST.stageSetup) ?? {};
  expect(databaseUrlKeys(host)).toStrictEqual(['DATABASE_URL', 'PARTY_REGISTRY_WORKER_DATABASE_URL']);
  expect(host.PARTY_REGISTRY_WORKER_DATABASE_URL).toBe(workerUrl);
});

it('gives the Shell its gateway issuer identity next to the shared runtime role', () => {
  const shell = serviceEnvironments().get('shellsuperapp') ?? {};

  expect(databaseUrlKeys(shell)).toStrictEqual(['DATABASE_URL', 'SHELL_GATEWAY_ISSUER_DATABASE_URL']);
  expect(shell.SHELL_GATEWAY_ISSUER_DATABASE_URL).toBe(
    identityUrl('shell_gateway_issuer', 'migrator_SHELL_GATEWAY_ISSUER_DB_PASSWORD'),
  );
});

it('lets only the migrator hold every database identity URL', () => {
  const environments = serviceEnvironments();
  const holders = [...environments].filter(
    ([, environment]) => databaseUrlKeys(environment).length === DATABASE_URL_KEYS.length,
  );

  expect(holders.map(([setup]) => setup)).toStrictEqual(['migrator']);
  // Zerops resolves a service's own variables without the hostname prefix, so the migrator, which owns
  // the identity passwords as its sensitive secrets, references `${<KEY>}` rather than `${migrator_<KEY>}`.
  expect(environments.get('migrator')).toMatchObject({
    PARTY_REGISTRY_DATABASE_URL: identityUrl('party_registry_runtime', 'PARTY_REGISTRY_DB_PASSWORD'),
    PARTY_REGISTRY_WORKER_DATABASE_URL: identityUrl('party_registry_worker', 'PARTY_REGISTRY_WORKER_DB_PASSWORD'),
    SHELL_GATEWAY_ISSUER_DATABASE_URL: identityUrl('shell_gateway_issuer', 'SHELL_GATEWAY_ISSUER_DB_PASSWORD'),
  });
});

it('references each identity password only from the migrator and the services that own it', () => {
  const environments = serviceEnvironments();
  const owners = {
    PARTY_REGISTRY_DB_PASSWORD: ['migrator', partyRegistrySetup],
    PARTY_REGISTRY_WORKER_DB_PASSWORD: ['migrator', PARTY_REGISTRY_WORKER_SETUP, OUTBOX_WORKER_HOST.stageSetup],
    SHELL_GATEWAY_ISSUER_DB_PASSWORD: ['migrator', 'shellsuperapp'],
  };

  for (const [secretKey, expected] of Object.entries(owners)) {
    const reference = new RegExp(`\\$\\{(?:migrator_)?${secretKey}\\}`, 'u');
    const referencing = [...environments]
      .filter(([, environment]) => Object.values(environment).some((value) => reference.test(value)))
      .map(([setup]) => setup);
    expect(referencing).toStrictEqual(expected);
  }
});

it('declares no project-level variable that could carry a database credential', () => {
  const deployment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    parse(readFileSync(zeropsYamlPath, 'utf-8')),
  );
  const imports = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    parse(readFileSync(zeropsImportPath, 'utf-8')),
  );

  // Every service inherits project variables, so identity passwords stay service secrets on the migrator.
  expect(Object.keys(deployment)).toStrictEqual(['zerops']);
  expect(Object.keys(imports)).toStrictEqual(['services']);
  expect(readFileSync(zeropsImportPath, 'utf-8')).not.toMatch(/envVariables|DB_PASSWORD|DATABASE_URL/u);
});

const StepInputsSchema = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]));
const MainHostWorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    'build-outbox-host': Schema.Struct({
      if: Schema.String,
      needs: Schema.Array(Schema.String),
      outputs: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(
        Schema.Struct({
          env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          id: Schema.optional(Schema.String),
          name: Schema.String,
          run: Schema.optional(Schema.String),
          with: Schema.optional(StepInputsSchema),
        }),
      ),
    }),
    'deploy-zerops': Schema.Struct({
      steps: Schema.Array(
        Schema.Struct({
          env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          if: Schema.optional(Schema.String),
          name: Schema.String,
          run: Schema.optional(Schema.String),
          uses: Schema.optional(Schema.String),
          with: Schema.optional(StepInputsSchema),
        }),
      ),
    }),
  }),
});
// zstd and jq come from Homebrew on macOS and from the system on Linux runners.
const PUSH_TEST_PATH = '/opt/homebrew/bin:/usr/bin:/bin';
const PUSH_TEST_BASH = os.platform() === 'darwin' ? '/opt/homebrew/bin/bash' : '/bin/bash';
const HOST_DIGEST_OUTPUT = `\${{ needs.build-outbox-host.outputs.digest }}`;
const RUNNER_TEMP_EXPRESSION = `\${{ runner.temp }}`;

/** Packs a host archive the way scripts/ci/build-outbox-host.sh lays it out, carrying `digest`. */
const writeHostArchive = (directory: string, digest: string): string => {
  const root = path.join(directory, 'archive');
  const runtime = path.join(root, 'app/.zerops/runtime', OUTBOX_WORKER_HOST.stageSetup);
  mkdirSync(path.join(runtime, 'node/bin'), { recursive: true });
  writeFileSync(path.join(runtime, 'worker.mjs'), '');
  writeFileSync(path.join(runtime, 'node/bin/node'), '#!/bin/sh\n');
  chmodSync(path.join(runtime, 'node/bin/node'), 0o755);
  writeFileSync(
    path.join(runtime, 'worker-artifact.json'),
    JSON.stringify({ artifactDigest: digest, schemaVersion: 3, serviceId: OUTBOX_WORKER_HOST.stageSetup }),
  );
  const archive = path.join(directory, 'outbox-host.tar.zst');
  const packed = spawnSync('/bin/sh', ['-c', 'tar -c -f - -C "$1" app | zstd --quiet -o "$2"', 'pack', root, archive], {
    encoding: 'utf-8',
  });
  expect(packed.stderr).toBe('');
  expect(packed.status).toBe(0);
  return archive;
};

it("deploys the main pipeline's planned Outbox Worker host from the artifact build-outbox-host built", () => {
  const { jobs } = Schema.decodeUnknownSync(MainHostWorkflowSchema)(parse(readFileSync(workflowPath, 'utf-8')));
  const build = jobs['build-outbox-host'];
  // The host builds only when the plan deploys it, and names its artifact after the digest it carries.
  expect(build.if).toContain(`contains(needs.deploy-plan.outputs.providers, '"${OUTBOX_WORKER_HOST.stageSetup}"')`);
  expect(build.outputs.digest).toBe(`\${{ steps.digest.outputs.digest }}`);
  expect(build.steps.find((step) => step.id === 'digest')?.run).toContain('scripts/ci/deploy-plan.mts host-digest');
  const recipe = build.steps.find((step) => step.run?.includes('app/scripts/ci/build-outbox-host.sh') === true);
  expect(recipe?.env?.ONTOS_OUTBOX_HOST_DIGEST).toBe(`\${{ steps.digest.outputs.digest }}`);
  const upload = build.steps.find((step) => step.name === 'Upload the host artifact');
  expect(upload?.with?.name).toBe(`outbox-host-\${{ steps.digest.outputs.digest }}`);
  expect(upload?.with?.path).toBe(`${RUNNER_TEMP_EXPRESSION}/outbox-host.tar.zst`);

  const { steps } = jobs['deploy-zerops'];
  const download = steps.findIndex((step) => step.with?.name === `outbox-host-${HOST_DIGEST_OUTPUT}`);
  const providers = steps.findIndex((step) => step.name === 'Deploy affected providers');
  expect(download).toBeGreaterThanOrEqual(0);
  expect(download).toBeLessThan(providers);
  expect(steps[download]?.uses).toMatch(/^actions\/download-artifact@/u);
  const downloaded = Schema.decodeUnknownSync(Schema.String)(steps[download]?.with?.path);
  const caller = steps[providers]?.env ?? {};
  expect(caller.OUTBOX_HOST_DIGEST).toBe(HOST_DIGEST_OUTPUT);
  expect(caller.OUTBOX_HOST_ARTIFACT).toBe(`${downloaded}/outbox-host.tar.zst`);

  // Run the shared script with exactly that caller's host environment and a stubbed Zerops CLI.
  const directory = mkdtempSync(path.join(os.tmpdir(), 'ontos-push-zerops-host-'));
  try {
    const runnerTemp = path.join(directory, 'runner');
    const digest = 'a'.repeat(64);
    mkdirSync(path.join(runnerTemp, 'outbox-host'), { recursive: true });
    const archive = writeHostArchive(path.join(runnerTemp, 'outbox-host'), digest);
    const resolve = (value: string | undefined) =>
      Schema.decodeUnknownSync(Schema.String)(value)
        .replaceAll(RUNNER_TEMP_EXPRESSION, runnerTemp)
        .replaceAll(HOST_DIGEST_OUTPUT, digest);
    expect(resolve(caller.OUTBOX_HOST_ARTIFACT)).toBe(archive);
    const bin = path.join(directory, 'bin');
    const calls = path.join(directory, 'calls');
    mkdirSync(bin);
    mkdirSync(path.join(directory, 'checkout/app'), { recursive: true });
    writeFileSync(path.join(bin, 'mise'), '#!/bin/sh\necho host-service-id\n');
    writeFileSync(path.join(bin, 'zcli'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >>"$ZCLI_CALLS"\n');
    chmodSync(path.join(bin, 'mise'), 0o755);
    chmodSync(path.join(bin, 'zcli'), 0o755);
    const push = (host: Readonly<Record<string, string>>) =>
      spawnSync(PUSH_TEST_BASH, [new URL(pushUnitsPath).pathname], {
        cwd: path.join(directory, 'checkout'),
        encoding: 'utf-8',
        env: {
          GITHUB_SHA: 'b'.repeat(40),
          PATH: `${bin}:${PUSH_TEST_PATH}`,
          RUNNER_TEMP: runnerTemp,
          UNITS_JSON: JSON.stringify([OUTBOX_WORKER_HOST.stageSetup]),
          ZCLI_CALLS: calls,
          ZEROPS_PROJECT_ID: 'project-id',
          ZEROPS_YAML_PATH: path.join(directory, 'zerops.yaml'),
          ...host,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });

    const deployed = push({
      OUTBOX_HOST_ARTIFACT: resolve(caller.OUTBOX_HOST_ARTIFACT),
      OUTBOX_HOST_DIGEST: resolve(caller.OUTBOX_HOST_DIGEST),
    });
    expect(deployed.stderr).toBe('');
    expect(deployed.status).toBe(0);
    const [deploy, ...rest] = readFileSync(calls, 'utf-8').trim().split('\n');
    expect(rest).toStrictEqual([]);
    expect(deploy).toMatch(
      /^service deploy --working-dir \S+ --path-to-file-or-dir app\/\.zerops\/runtime\/outbox-worker-host /u,
    );
    expect(deploy).toContain('--service-id host-service-id --setup outbox-worker-host');

    // An artifact that carries another digest, or none at all, never deploys.
    rmSync(calls);
    const stale = push({ OUTBOX_HOST_ARTIFACT: archive, OUTBOX_HOST_DIGEST: 'c'.repeat(64) });
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(`does not carry host digest ${'c'.repeat(64)}`);
    const missing = push({});
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('OUTBOX_HOST_ARTIFACT');
    // Only best-effort log collection may reach the Zerops CLI after a refused artifact.
    const refused = existsSync(calls) ? readFileSync(calls, 'utf-8').trim().split('\n') : [];
    expect(refused.filter((line) => !line.startsWith('service log '))).toStrictEqual([]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
