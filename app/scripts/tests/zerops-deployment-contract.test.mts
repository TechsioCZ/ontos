import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Effect, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { loadApplicationMigrationInventory } from '../application-migration-inventory.mts';
import {
  DEPLOYMENT_ENVIRONMENT_VARIABLE,
  materializeZeropsEnvironment,
  SPICEDB_ENDPOINT_VARIABLE,
} from '../materialize-zerops-environment.mts';
import { generateOutboxWorkerDeployment } from '../generate-outbox-worker-deployment.mjs';
import { OUTBOX_WORKER_HOST } from '../outbox-worker-delivery.mjs';
import {
  gatewayModuleBindingsProblem,
  OWNER_RUNTIME_CONFIGURATIONS,
  requestServiceHoldsModuleCredential,
  SHELL_GATEWAY_BASE_URL_VARIABLE,
} from '../ops/owner-runtime-configuration.mts';

const runtimeDatabaseUrl = `DATABASE_URL: postgresql://ontos_runtime:\${db18_password}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`;
const commerceCustomerContextSetup = 'commerce-customer-context';
const priceGroupCatalogSetup = 'price-group-catalog';
const PARTY_REGISTRY_WORKER_SETUP = 'party-registry-worker';
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

const ORDER_MODULE_SETUPS = ['commerce-order', 'commerce-order-worker'] as const;
const ORDER_RUNTIME_SETUPS = [...ORDER_MODULE_SETUPS, OUTBOX_WORKER_HOST.stageSetup];
it('binds Commerce Order, its worker and the host to every internal owner API base Order calls', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');

  for (const setup of ORDER_RUNTIME_SETUPS) {
    const block = serviceBlock(zeropsYaml, setup);
    for (const binding of [
      "ONTOS_COMMERCE_CART_API_BASE_URL: 'http://commercecart:4115/commerce-cart-api'",
      "ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL: 'http://commercecustomercontext:4101/commerce-customer-context-api'",
      "ONTOS_ORDER_API_BASE_URL: 'http://commerceorder:4116/commerce-order-api'",
      "ONTOS_PAYMENT_TERM_CATALOG_API_BASE_URL: 'http://paymenttermcatalog:4103/payment-term-catalog-api'",
      "ONTOS_PRICING_API_BASE_URL: 'http://pricing:4106/pricing-api'",
      "ONTOS_SHELL_GATEWAY_BASE_URL: 'http://shellsuperapp:3020/shell-super-app-api'",
      "ONTOS_TAX_API_BASE_URL: 'http://tax:4112/tax-api'",
    ]) {
      expect(block).toContain(`        ${binding}\n`);
    }
  }
});

it('gives the Order runtimes the Order module credential and no other owner credential', () => {
  const environments = serviceEnvironments();

  for (const setup of ORDER_MODULE_SETUPS) {
    expect(environments.get(setup)?.ONTOS_GATEWAY_MODULE_API_KEY).toBe(
      `\${migrator_ONTOS_GATEWAY_MODULE_API_KEY_COMMERCE_ORDER}`,
    );
  }
  // The Outbox Worker host receives each hosted owner's credential under its own per-unit name instead.
  expect(environments.get(OUTBOX_WORKER_HOST.stageSetup)?.ONTOS_GATEWAY_MODULE_API_KEY).toBeUndefined();
});

/** An owner's own service and, when it has an Outbox Worker, that worker. The shared host carries no module credential. */
const ownerRuntimeSetups = (unitId: string, setups: ReadonlySet<string>) =>
  setups.has(`${unitId}-worker`) ? [unitId, `${unitId}-worker`] : [unitId];

/** Every non-test source file under `verticals/`, skipping installed packages and test folders. */
const verticalSourceFiles = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'tests' ? [] : verticalSourceFiles(entryPath);
    }
    return /\.m?ts$/u.test(entry.name) && !/\.test\./u.test(entry.name) ? [entryPath] : [];
  });

/** The vertical units whose production code calls another module through the delegated gateway client. */
const delegatedCallerUnits = (): readonly string[] => {
  const verticals = fileURLToPath(new URL('../../verticals/', import.meta.url));
  const callers = new Set(
    verticalSourceFiles(verticals)
      .filter((file) => {
        const source = readFileSync(file, 'utf-8');
        return (
          source.includes("'@app/shared-contracts/gateway-context-server'") &&
          source.includes('acquireDelegatedGatewayContext')
        );
      })
      .map((file) => path.relative(verticals, file).split(path.sep)[0] ?? ''),
  );
  return EffectArray.sort([...callers], Order.String);
};

it('gives every module that calls another module its own module credential, and no other module one', () => {
  const environments = serviceEnvironments();
  const setups = new Set(environments.keys());
  const configured = EffectArray.sort(
    OWNER_RUNTIME_CONFIGURATIONS.map(({ unitId }) => unitId),
    Order.String,
  );

  expect(configured).toStrictEqual(delegatedCallerUnits());
  for (const configuration of OWNER_RUNTIME_CONFIGURATIONS) {
    const { credentialVariables, moduleCredentialVariable, operatorValues, unitId } = configuration;
    const expected = ownerRuntimeSetups(unitId, setups);
    const moduleReference = `\${migrator_${moduleCredentialVariable}}`;
    const moduleHolders = [...environments]
      .filter(([, environment]) => environment.ONTOS_GATEWAY_MODULE_API_KEY === moduleReference)
      .map(([setup]) => setup);
    // A `worker-only` unit's request service receives no module credential; its Outbox Worker alone holds it.
    expect(moduleHolders).toStrictEqual(
      requestServiceHoldsModuleCredential(configuration) ? expected : expected.filter((setup) => setup !== unitId),
    );
    // Only the deployments that hold the module credential call other modules, so only they get the Shell base.
    for (const setup of moduleHolders) {
      expect(environments.get(setup)?.[SHELL_GATEWAY_BASE_URL_VARIABLE]).toContain(
        'shellsuperapp:3020/shell-super-app-api',
      );
    }
    for (const key of [...credentialVariables, ...operatorValues.map(({ variable }) => variable)]) {
      const holders = [...environments]
        .filter(([, environment]) =>
          Object.entries(environment).some(([name, value]) => name === key || value.includes(key)),
        )
        .map(([setup]) => setup);
      expect(holders).toStrictEqual(expected);
      for (const setup of expected) {
        expect(environments.get(setup)?.[key]).toBe(`\${migrator_${key}}`);
      }
    }
  }
});

/** The hosted owners whose workers hold a module credential, with the host entry binding of each. */
const HOSTED_OWNER_CREDENTIALS = [
  { binding: 'partyRegistryOutboxWorkerEntry', variable: 'ONTOS_GATEWAY_MODULE_API_KEY_PARTY_REGISTRY' },
  {
    binding: 'commerceCustomerContextOutboxWorkerEntry',
    variable: 'ONTOS_GATEWAY_MODULE_API_KEY_COMMERCE_CUSTOMER_CONTEXT',
  },
  { binding: 'privacyOutboxWorkerEntry', variable: 'ONTOS_GATEWAY_MODULE_API_KEY_PRIVACY' },
  { binding: 'commerceOrderOutboxWorkerEntry', variable: 'ONTOS_GATEWAY_MODULE_API_KEY_COMMERCE_ORDER' },
  { binding: 'symmyIntegrationOutboxWorkerEntry', variable: 'ONTOS_GATEWAY_MODULE_API_KEY_SYMMY_INTEGRATION' },
] as const;

it.effect('hands the stage host each hosted owner credential under its own name and never the shared one', () =>
  Effect.gen(function* hostReceivesPerUnitCredentials() {
    const source = readFileSync(zeropsYamlPath, 'utf-8');
    const generated = yield* Effect.promise(() =>
      Promise.resolve(generateOutboxWorkerDeployment(fileURLToPath(new URL('../../', import.meta.url)), source)),
    );
    const hostEnvironment = serviceEnvironments().get(OUTBOX_WORKER_HOST.stageSetup);

    expect(hostEnvironment?.ONTOS_GATEWAY_MODULE_API_KEY).toBeUndefined();
    for (const { binding, variable } of HOSTED_OWNER_CREDENTIALS) {
      expect(hostEnvironment?.[variable]).toBe(`\${migrator_${variable}}`);
      // The host entry runs that owner's layer under its own variable; the host runtime maps the shared name onto it.
      expect(generated.hostEntry).toMatch(
        new RegExp(`hostedOutboxWorkerEntry\\(\\s*${binding},\\s*'${variable}',?\\s*\\)`, 'u'),
      );
    }
    // Inventory makes no delegated calls, so its entry runs without a module credential.
    expect(generated.hostEntry).toContain('\n    inventoryOutboxWorkerEntry,\n');
    expect(readFileSync(new URL('../outbox-worker-host.generated.mts', import.meta.url), 'utf-8')).toBe(
      generated.hostEntry,
    );
  }),
);

const bindingFor = (sourceAppId: string, providerKeyId = `key-${sourceAppId}`) => ({
  compositionRevision: 'a'.repeat(64),
  providerKeyId,
  sourceAppId,
  sourceBuildMarker: `build-${sourceAppId}`,
});
const expectedBindings = OWNER_RUNTIME_CONFIGURATIONS.map(({ unitId }) => bindingFor(unitId));

it('accepts exactly one Shell binding per module credential, all for one composition revision', () => {
  expect(gatewayModuleBindingsProblem(JSON.stringify(expectedBindings))).toBeUndefined();
  expect(gatewayModuleBindingsProblem('not json')).toMatch(/JSON array/u);
  expect(gatewayModuleBindingsProblem(JSON.stringify(expectedBindings.slice(1)))).toMatch(/exactly one binding/u);
  expect(gatewayModuleBindingsProblem(JSON.stringify([...expectedBindings, bindingFor('privacy')]))).toMatch(
    /exactly one binding/u,
  );
  expect(
    gatewayModuleBindingsProblem(
      JSON.stringify(expectedBindings.map((binding) => ({ ...binding, providerKeyId: 'shared-key' }))),
    ),
  ).toMatch(/own provider key/u);
  expect(
    gatewayModuleBindingsProblem(
      JSON.stringify(
        expectedBindings.map((binding, index) =>
          index === 0 ? { ...binding, compositionRevision: 'b'.repeat(64) } : binding,
        ),
      ),
    ),
  ).toMatch(/same composition revision/u);
});

it('gives the Shell the module bindings from the migrator and no other service', () => {
  const environments = serviceEnvironments();
  const holders = [...environments]
    .filter(([, environment]) =>
      Object.values(environment).some((value) => value.includes('ONTOS_GATEWAY_MODULE_BINDINGS')),
    )
    .map(([setup]) => setup);

  expect(environments.get('shellsuperapp')?.ONTOS_GATEWAY_MODULE_BINDINGS).toBe(
    `\${migrator_ONTOS_GATEWAY_MODULE_BINDINGS}`,
  );
  expect(holders).toStrictEqual(['shellsuperapp']);
});

it('retires the per-owner gateway keys, grant lists, principal IDs and caller namespaces', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');

  expect(zeropsYaml).not.toMatch(
    /_GATEWAY_API_KEY|_SERVICE_API_KEY|_SERVICE_GRANTS|_PRINCIPAL_ID|_NAMESPACE_ID|CONSUMER_LEGAL_ENTITY|CONSUMER_TENANT/u,
  );
  expect(zeropsYaml).not.toContain('ONTOS_GATEWAY_RELAY_');
});

it('binds Customer Context, Cart and Pricing to the internal owner API bases they call', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  const shellBase = "ONTOS_SHELL_GATEWAY_BASE_URL: 'http://shellsuperapp:3020/shell-super-app-api'";
  const cartBase = "ONTOS_COMMERCE_CART_API_BASE_URL: 'http://commercecart:4115/commerce-cart-api'";
  const bindings: readonly (readonly [readonly string[], readonly string[]])[] = [
    [
      [commerceCustomerContextSetup, `${commerceCustomerContextSetup}-worker`, OUTBOX_WORKER_HOST.stageSetup],
      [cartBase, "ONTOS_COMMERCE_ORDER_API_BASE_URL: 'http://commerceorder:4116/commerce-order-api'", shellBase],
    ],
    [
      ['commerce-cart'],
      [
        "ONTOS_CATALOG_API_BASE_URL: 'http://catalog:4105/catalog-api'",
        "ONTOS_COMMERCE_CUSTOMER_CONTEXT_API_BASE_URL: 'http://commercecustomercontext:4101/commerce-customer-context-api'",
        shellBase,
      ],
    ],
    [['pricing'], [shellBase]],
  ];

  for (const [setups, lines] of bindings) {
    for (const setup of setups) {
      const block = serviceBlock(zeropsYaml, setup);
      for (const line of lines) {
        expect(block).toContain(`        ${line}\n`);
      }
    }
  }
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
  const deploy = deploySteps.indexOf('Deploy the selected Outbox Workers');
  const stopOtherMode = deploySteps.indexOf("Stop the other Outbox Worker mode's workers");
  const publish = deploySteps.indexOf('Publish the complete active Application Composition');
  expect(deploy).toBeGreaterThanOrEqual(0);
  expect(stopOtherMode).toBeGreaterThan(deploy);
  expect(publish).toBeGreaterThan(stopOtherMode);
});

it('declares the Inventory public URL for Cloudflare proof', () => {
  const workflow = readFileSync(
    new URL('../../../.github/workflows/ultramodern-workspace-gates.yml', import.meta.url),
    'utf-8',
  );

  expect(workflow).toContain('ULTRAMODERN_PUBLIC_URL_INVENTORY: https://inventory.invalid');
});

it('declares no dedicated Price Group worker once the module has no Outbox Worker left (O62)', () => {
  const zeropsYaml = readFileSync(zeropsYamlPath, 'utf-8');
  // Price Group Catalog's only worker was the legacy business-permission containment mirror; with it
  // gone the module has no dedicated worker and no hosted entry, and no stale service may remain.
  expect(zeropsYaml).not.toContain(`setup: 'price-group-catalog-worker'`);
  const imports = readFileSync(zeropsImportPath, 'utf-8');
  expect(imports).not.toContain('hostname: pricegroupcatalogworker');
  const hostEntry = readFileSync(new URL('../outbox-worker-host.generated.mts', import.meta.url), 'utf-8');
  expect(hostEntry).not.toContain('priceGroupCatalogOutboxWorkerEntry');
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
  for (const worker of [PARTY_REGISTRY_WORKER_SETUP, 'commerce-customer-context-worker']) {
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
    expect(block).toContain('sudo apk add --no-cache curl libstdc++ libatomic');
    expect(block).toContain(
      "    run:\n      base: 'nodejs@24'\n      prepareCommands:\n        - sudo apk add --no-cache libatomic\n",
    );
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

it.effect('ships every package available to the native migration inventory', () =>
  Effect.gen(function* nativeMigrationArtifactCoverage() {
    const migrator = serviceBlock(readFileSync(zeropsYamlPath, 'utf-8'), 'migrator');
    const streams = yield* loadApplicationMigrationInventory();
    const migratedPackages = streams.map(({ directory }) => directory);
    expect(migratedPackages).toContain('verticals/catalog');
    for (const directory of new Set(migratedPackages)) {
      expect(migrator).toMatch(new RegExp(`^ +- 'app/(?:${directory}|${directory.split('/')[0]})'$`, 'mu'));
    }
    expect(migrator).toContain("- 'app/topology'");
  }).pipe(Effect.provide(NodeServices.layer)),
);

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

it.effect('passes a custom reviewed intent to only the remote host build in the provider copy', () =>
  Effect.gen(function* remoteHostReleaseIntent() {
    const source = readFileSync(zeropsYamlPath, 'utf-8');
    const compositionIntentFile = 'topology/custom-reviewed-release.json';
    const materialized = yield* materializeZeropsEnvironment(source, { compositionIntentFile, environment: 'stage' });
    const documentSchema = Schema.Struct({
      zerops: Schema.Array(
        Schema.Struct({
          build: Schema.Struct({ envVariables: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
          run: Schema.Struct({ envVariables: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
          setup: Schema.String,
        }),
      ),
    });
    const document = Schema.decodeUnknownSync(documentSchema)(parse(materialized));
    const host = document.zerops.find(({ setup }) => setup === OUTBOX_WORKER_HOST.stageSetup);
    expect(host?.build.envVariables?.COMPOSITION_INTENT_FILE).toBe(compositionIntentFile);
    for (const service of document.zerops) {
      expect(service.run.envVariables?.COMPOSITION_INTENT_FILE).toBeUndefined();
      if (service.setup !== OUTBOX_WORKER_HOST.stageSetup) {
        expect(service.build.envVariables?.COMPOSITION_INTENT_FILE).toBeUndefined();
      }
    }
    expect(readFileSync(zeropsYamlPath, 'utf-8')).toBe(source);
    for (const intentFile of ['', '../outside.json', '/outside.json']) {
      const rejected = yield* materializeZeropsEnvironment(source, {
        compositionIntentFile: intentFile,
        environment: 'stage',
      }).pipe(Effect.flip);
      expect(rejected.message).toContain('workspace-relative');
    }
  }),
);

it('connects Party Registry only as its dedicated request identity', () => {
  const party = serviceEnvironments().get('party-registry') ?? {};

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
    PARTY_REGISTRY_DB_PASSWORD: ['migrator', 'party-registry'],
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
