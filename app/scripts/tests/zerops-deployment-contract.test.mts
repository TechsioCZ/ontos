import { readFileSync } from 'node:fs';

import { Array as Arr, Effect, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { isMap, isScalar, isSeq, parse, parseDocument, YAMLMap, YAMLSeq } from 'yaml';

import {
  DEPLOYMENT_ENVIRONMENT_VARIABLE,
  materializeZeropsEnvironment,
  materializeZeropsSetupFiles,
  SPICEDB_ENDPOINT_VARIABLE,
} from '../materialize-zerops-environment.mts';
import { readZeropsDeploymentYaml } from './zerops-deployment.fixture.mts';

/** The whole stage deployment: the SpiceDB data plane, the storefront, and the one application container. */
const SETUPS = ['spicedb', 'storefront', 'app'];
const runtimeDatabaseUrl = `DATABASE_URL: postgresql://ontos_runtime:\${db18_password}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`;
const zeropsImportPath = new URL('../../zerops-import.yaml', import.meta.url);

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
const ServiceEnvironmentSchema = Schema.Struct({
  zerops: Schema.Array(
    Schema.Struct({
      run: Schema.Struct({ envVariables: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
      setup: Schema.String,
    }),
  ),
});
/** The four database identity URLs; only the application container holds all of them. */
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
    Schema.decodeUnknownSync(ServiceEnvironmentSchema)(parse(readZeropsDeploymentYaml())).zerops.map(
      ({ run, setup }) => [setup, run.envVariables ?? {}],
    ),
  );

const databaseUrlKeys = (environment: Readonly<Record<string, string>>) =>
  DATABASE_URL_KEYS.filter((key) => environment[key] !== undefined);

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

it('has exactly the spicedb, storefront and app setups, in that order', () => {
  const setups = Schema.decodeUnknownSync(ZeropsYamlSchema)(parse(readZeropsDeploymentYaml())).zerops.map(
    ({ setup }) => setup,
  );
  expect(setups).toStrictEqual(SETUPS);
});

it('binds generated PostgreSQL credentials into the application container', () => {
  expect(serviceBlock(readZeropsDeploymentYaml(), 'app')).toContain(runtimeDatabaseUrl);
});

it('binds the SpiceDB datastore password, never a URL, into the SpiceDB and application services', () => {
  const zeropsYaml = readZeropsDeploymentYaml();
  const spicedb = serviceBlock(zeropsYaml, 'spicedb');

  expect(serviceBlock(zeropsYaml, 'app')).toContain(`SPICEDB_DATABASE_PASSWORD: \${spicedb_SPICEDB_DATABASE_PASSWORD}`);
  expect(spicedb).toContain(`SPICEDB_DATABASE_HOST: \${db18_hostname}`);
  expect(spicedb).toContain(`SPICEDB_DATABASE_PORT: \${db18_port}`);
  expect(serviceStrings(serviceNode(zeropsYaml, 'spicedb'), ['build', 'deployFiles'])).toContain(
    'app/scripts/spicedb-datastore-uri.sh',
  );
  expect(zeropsYaml).not.toContain('SPICEDB_DATASTORE_CONN_URI');
  expect(zeropsYaml).not.toContain('SPICEDB_DATABASE_URL');
});

it('runs the whole application in the app container through the shipped Node, from the whole workspace', () => {
  const app = serviceNode(readZeropsDeploymentYaml(), 'app');

  expect(app.getIn(['run', 'start'])).toBe(
    `sh -c 'cd app && PATH="$PWD/.zerops/node/bin:$PATH" exec node scripts/zerops/app-host.mts'`,
  );
  expect(serviceStrings(app, ['build', 'deployFiles'])).toStrictEqual(['app/']);
  for (const branch of [
    ['deploy', 'readinessCheck'],
    ['run', 'healthCheck'],
  ]) {
    expect(app.getIn([...branch, 'httpGet', 'port'])).toBe(3000);
  }
  expect(app.getIn(['run', 'healthCheck', 'httpGet', 'path'])).toBe('/_host/live');
  expect(app.getIn(['deploy', 'readinessCheck', 'httpGet', 'path'])).toBe('/_host/ready');
});

it('starts the storefront from its standalone bundle and keeps the Shell URL in-project', () => {
  const storefront = serviceBlock(readZeropsDeploymentYaml(), 'storefront');

  expect(storefront).toContain('exec node/bin/node akros-storefront/server.js');
  expect(storefront).toContain('ONTOS_SHELL_URL: http://app:3000');
});

it('fails the application build whose Zephyr upload fails', () => {
  const app = serviceNode(readZeropsDeploymentYaml(), 'app');

  expect(app.getIn(['build', 'envVariables', 'ZE_FAIL_BUILD'])).toBe('true');
});

it('excludes compressed asset copies from both CI archives and the final Zerops package', () => {
  const deployIgnore = readFileSync(new URL('../../../.deployignore', import.meta.url), 'utf-8');
  const workflow = readFileSync(new URL('../../../.github/workflows/zerops-stage.yml', import.meta.url), 'utf-8');
  for (const extension of ['br', 'gz']) {
    expect(deployIgnore).toContain(`app/apps/*/dist/**/*.${extension}`);
    expect(deployIgnore).toContain(`app/verticals/*/dist/**/*.${extension}`);
    expect(workflow).toContain(`--exclude='*.${extension}'`);
  }
});

it('bakes the public origins the app runs with into its bundles, including the AKROS storefront', () => {
  const app = serviceNode(readZeropsDeploymentYaml(), 'app');
  const buildApp = readFileSync(new URL('../zerops/build-app.sh', import.meta.url), 'utf-8');

  for (const key of ['ONTOS_PUBLIC_ORIGIN', 'ONTOS_STOREFRONT_ORIGIN']) {
    expect(app.getIn(['build', 'envVariables', key])).toBe(app.getIn(['run', 'envVariables', key]));
  }
  // Without it the merchandise and Shell bundles fall back to the local storefront (http://localhost:3070).
  expect(buildApp).toContain('export ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT="$ONTOS_STOREFRONT_ORIGIN"');
});

it('builds every Node service with the pinned toolchain and ships Node instead of downloading it at start', () => {
  const zeropsYaml = readZeropsDeploymentYaml();
  const node = /^node = "(?<node>[^"]+)"$/mu.exec(readFileSync(new URL('../../.mise.toml', import.meta.url), 'utf-8'))
    ?.groups?.node;
  const pnpm = /"packageManager": "pnpm@(?<pnpm>[^"+]+)"/u.exec(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
  )?.groups?.pnpm;
  const nodeServices = zeropsYaml
    .split(/(?=^ {2}- setup:)/mu)
    .filter((block) => block.includes('install-zerops-node.sh'));

  expect(nodeServices.length).toBe(2);
  for (const block of nodeServices) {
    expect(block).toContain(`install-zerops-node.sh ${node} ${pnpm}\n`);
    expect(block).toContain(`"$HOME/.local/node-${node}/bin`);
    expect(block).toMatch(/start: sh -c '.*exec (?:node\/bin\/node|node) /u);
    expect(block).not.toContain('initCommands');
    expect(block).not.toMatch(/virtual-store|VIRTUAL_STORE|--force|reset-workspace-dependencies/u);
  }
});

it.effect('materializes every Zerops setup with the deploying environment named in its builds and runtimes', () =>
  Effect.gen(function* materializedEnvironment() {
    const zeropsYaml = readZeropsDeploymentYaml();
    const source = parseDocument(zeropsYaml);
    // Every setup file stays within Zerops' 50 kB limit; rejoined they are the whole deployment.
    const pushedFiles = (files: readonly { readonly file: string; readonly setup: string }[]) => {
      expect(files.map(({ setup }) => setup)).toEqual(
        Schema.decodeUnknownSync(ZeropsYamlSchema)(parse(zeropsYaml)).zerops.map(({ setup }) => setup),
      );
      for (const { file } of files) {
        expect(new TextEncoder().encode(file).byteLength).toBeLessThan(50_000);
      }
      return `zerops:\n${files.map(({ file }) => file.replace(/^zerops:\n/u, '')).join('')}`;
    };
    const stage = pushedFiles(yield* materializeZeropsSetupFiles(zeropsYaml, { environment: 'stage' }));
    expect(Schema.decodeUnknownSync(Schema.Unknown)(parse(stage))).toEqual(
      Schema.decodeUnknownSync(Schema.Unknown)(parse(zeropsYaml)),
    );
    const productionEndpoint = 'spicedb.production.example:443';
    const production = pushedFiles(
      yield* materializeZeropsSetupFiles(zeropsYaml, {
        environment: 'production',
        spiceDbEndpoint: productionEndpoint,
      }),
    );
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
  }),
);

it('connects the application container to each database identity only through its own URL', () => {
  const app = serviceEnvironments().get('app') ?? {};

  expect(databaseUrlKeys(app)).toStrictEqual(DATABASE_URL_KEYS);
  expect(app.DATABASE_URL).toBe(identityUrl('ontos_runtime', 'db18_password'));
  expect(app.COMMERCE_PORTAL_AUTH_DATABASE_URL).toBe(identityUrl('ontos_runtime', 'db18_password'));
  expect(app.PARTY_REGISTRY_DATABASE_URL).toBe(
    identityUrl('party_registry_runtime', 'migrator_PARTY_REGISTRY_DB_PASSWORD'),
  );
  expect(app.PARTY_REGISTRY_WORKER_DATABASE_URL).toBe(
    identityUrl('party_registry_worker', 'migrator_PARTY_REGISTRY_WORKER_DB_PASSWORD'),
  );
  expect(app.SHELL_GATEWAY_ISSUER_DATABASE_URL).toBe(
    identityUrl('shell_gateway_issuer', 'migrator_SHELL_GATEWAY_ISSUER_DB_PASSWORD'),
  );
});

it('uses the superuser only in the admin URLs the application supervisor reads', () => {
  const app = serviceEnvironments().get('app') ?? {};

  expect(app.DATABASE_ADMIN_URL).toBe(
    `postgresql://\${db18_superUser}:\${db18_superUserPassword}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`,
  );
  const superuserReferences = Object.entries(app)
    .filter(([, value]) => value.includes(`\${db18_superUserPassword}`))
    .map(([key]) => key);
  expect(Arr.sort(superuserReferences, Order.String)).toStrictEqual([
    'COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL',
    'DATABASE_ADMIN_URL',
  ]);
});

it('references each identity password only from the application container', () => {
  const environments = serviceEnvironments();
  const owners = {
    PARTY_REGISTRY_DB_PASSWORD: ['app'],
    PARTY_REGISTRY_WORKER_DB_PASSWORD: ['app'],
    SHELL_GATEWAY_ISSUER_DB_PASSWORD: ['app'],
  };

  for (const [secretKey, expected] of Object.entries(owners)) {
    const reference = new RegExp(`\\$\\{(?:migrator_)?${secretKey}\\}`, 'u');
    const referencing = [...environments]
      .filter(([, environment]) => Object.values(environment).some((value) => reference.test(value)))
      .map(([setup]) => setup);
    expect(referencing).toStrictEqual(expected);
  }
});

it('declares the import list of the data plane, the migrator secrets, the app and the storefront only', () => {
  const { services } = Schema.decodeUnknownSync(ZeropsImportSchema)(parse(readFileSync(zeropsImportPath, 'utf-8')));

  expect(
    services.map(
      ({ enableSubdomainAccess = false, hostname, type }) => `${hostname} ${type} ${String(enableSubdomainAccess)}`,
    ),
  ).toStrictEqual([
    'db18 postgresql:single@18 false',
    'spicedb docker@26.1.5 false',
    'migrator nodejs@24 false',
    'app nodejs@24 true',
    'storefront nodejs@24 true',
  ]);
  for (const { hostname } of services) {
    expect(hostname).toMatch(/^[a-z0-9]{1,25}$/u);
  }
  // Services reach each other by Zerops hostname, which never contains a hyphen.
  const hostnames = new Set(services.map(({ hostname }) => hostname));
  for (const [, host] of readZeropsDeploymentYaml().matchAll(/http:\/\/(?<host>[^/:']+):/gu)) {
    expect(hostnames).toContain(host);
  }
});

it('reserves the application working set and one dedicated CPU while preserving free-memory and replica limits', () => {
  const services = Schema.decodeUnknownSync(Schema.instanceOf(YAMLSeq))(
    parseDocument(readFileSync(zeropsImportPath, 'utf-8')).get('services', true),
  );
  const app = Schema.decodeUnknownSync(Schema.instanceOf(YAMLMap))(
    services.items.find((service) => isMap(service) && service.get('hostname') === 'app'),
  );

  expect(app.getIn(['verticalAutoscaling', 'minRam'])).toBe(2.5);
  expect(app.getIn(['verticalAutoscaling', 'maxRam'])).toBe(4);
  expect(app.getIn(['verticalAutoscaling', 'minFreeRamGB'])).toBe(0.5);
  expect(app.getIn(['verticalAutoscaling', 'cpuMode'])).toBe('DEDICATED');
  expect(app.getIn(['verticalAutoscaling', 'minCpu'])).toBe(1);
  expect(app.getIn(['verticalAutoscaling', 'maxCpu'])).toBe(1);
  expect(app.get('minContainers')).toBe(1);
  expect(app.get('maxContainers')).toBe(1);
});

it('declares no project-level variable that could carry a database credential', () => {
  const deployment = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    parse(readZeropsDeploymentYaml()),
  );
  const imports = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    parse(readFileSync(zeropsImportPath, 'utf-8')),
  );

  // Every service inherits project variables, so identity passwords stay service secrets on the migrator.
  expect(Object.keys(deployment)).toStrictEqual(['zerops']);
  expect(Object.keys(imports)).toStrictEqual(['services']);
  expect(readFileSync(zeropsImportPath, 'utf-8')).not.toMatch(/envVariables|DB_PASSWORD|DATABASE_URL/u);
});
