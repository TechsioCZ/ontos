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
import { MUTATION_MARKER } from '../zerops/delivery-plan.mts';
import { readZeropsDeploymentYaml } from './zerops-deployment.fixture.mts';
import { declaresModuleCalls } from '../ops/owner-runtime-configuration.mts';

/** The whole stage deployment: the SpiceDB data plane, the storefront, and the one application container. */
const SETUPS = ['spicedb', 'storefront', 'n1', 'app'];
const runtimeDatabaseUrl = `DATABASE_URL: postgresql://ontos_runtime:\${db18_password}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`;
const zeropsImportPath = new URL('../../zerops-import.yaml', import.meta.url);
const stageWorkflowPath = new URL('../../../.github/workflows/zerops-stage.yml', import.meta.url);
const deliverStageActionPath = new URL('../../../.github/actions/deliver-stage/action.yml', import.meta.url);
const stagePushPath = new URL('../zerops/stage-push.sh', import.meta.url);
const DELIVER_STAGE = './.github/actions/deliver-stage';
const INSTALL_APP = './.github/actions/install-app';
const INSTALL_WORKSPACE = 'Install the app workspace';

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

/** The app's start-time release step and the runtime tools it needs (scripts/zerops/unpack-app-release.sh). */
const APP_RELEASE_UNPACK = 'sh .zerops-release/unpack.sh';
const APP_RELEASE_TOOLS = 'sudo apk add --no-cache tar zstd';

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

it('has exactly the spicedb, storefront, n1 and app setups, in that order', () => {
  const setups = Schema.decodeUnknownSync(ZeropsYamlSchema)(parse(readZeropsDeploymentYaml())).zerops.map(
    ({ setup }) => setup,
  );
  expect(setups).toStrictEqual(SETUPS);
});

/** The checked-in zerops.yaml and every setup file materialized from it for stage and production. */
const everyDeploymentYaml = Effect.gen(function* everyDeploymentYaml() {
  const source = readZeropsDeploymentYaml();
  const stage = yield* materializeZeropsSetupFiles(source, { environment: 'stage' });
  const production = yield* materializeZeropsSetupFiles(source, {
    environment: 'production',
    spiceDbEndpoint: 'spicedb.production.example:443',
  });
  return [source, ...stage.map(({ file }) => file), ...production.map(({ file }) => file)];
});

/** Zerops's duration syntax (`10s`, `3m`, `1h0m0s`) in seconds; anything else is not a duration. */
const DURATION = /^(?:(?<hours>\d+)h)?(?:(?<minutes>\d+)m)?(?:(?<seconds>\d+)s)?$/u;
const durationSeconds = (value: string): number | undefined => {
  const groups = value === '' ? undefined : DURATION.exec(value)?.groups;
  return groups === undefined
    ? undefined
    : Number(groups.hours ?? 0) * 3600 + Number(groups.minutes ?? 0) * 60 + Number(groups.seconds ?? 0);
};
/** Zerops refuses a probe `retryPeriod` outside 10 s to 1 h: the whole build-and-deploy request answers 400. */
const RETRY_PERIOD_SECONDS = { max: 3600, min: 10 } as const;
const retryPeriodAccepted = (value: string) => {
  const seconds = durationSeconds(value);
  return seconds !== undefined && seconds >= RETRY_PERIOD_SECONDS.min && seconds <= RETRY_PERIOD_SECONDS.max;
};

it('accepts only probe retry periods Zerops accepts', () => {
  expect(['10s', '1m', '1h', '1h0m0s'].every(retryPeriodAccepted)).toBe(true);
  expect(['2s', '9s', '1h0m1s', '2h', '10', ''].some(retryPeriodAccepted)).toBe(false);
});

it.effect('keeps every readiness and health check retry period within the 10 s to 1 h Zerops accepts', () =>
  Effect.gen(function* probeRetryPeriods() {
    const yamls = yield* everyDeploymentYaml;
    let checked = 0;
    for (const yaml of yamls) {
      const { zerops } = Schema.decodeUnknownSync(ZeropsYamlSchema)(parse(yaml));
      for (const { setup } of zerops) {
        const service = serviceNode(yaml, setup);
        for (const probe of [
          ['deploy', 'readinessCheck'],
          ['run', 'readinessCheck'],
          ['run', 'healthCheck'],
        ]) {
          const period = service.getIn([...probe, 'retryPeriod']);
          if (period !== undefined) {
            checked += 1;
            const value = Schema.decodeUnknownSync(Schema.String)(period);
            expect(retryPeriodAccepted(value), `${setup} ${probe.join('.')}.retryPeriod ${value}`).toBe(true);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  }),
);

it.effect('repairs checkout ownership before any build command in every setup with a restored build cache', () =>
  Effect.gen(function* cachedBuildOwnership() {
    const yamls = yield* everyDeploymentYaml;
    for (const yaml of yamls) {
      const { zerops } = Schema.decodeUnknownSync(ZeropsYamlSchema)(parse(yaml));
      for (const { setup } of zerops) {
        const service = serviceNode(yaml, setup);
        if (serviceStrings(service, ['build', 'cache']).length > 0) {
          const [firstCommand] = serviceStrings(service, ['build', 'buildCommands']);
          expect(firstCommand?.split(' && ')[0], `${setup}: restored build cache must belong to the build user`).toBe(
            'sudo chown -R "$(id -u):$(id -g)" .',
          );
        }
      }
    }
  }),
);

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

it('runs the whole application in the app container through native Node, from the whole workspace', () => {
  const app = serviceNode(readZeropsDeploymentYaml(), 'app');

  expect(app.getIn(['run', 'start'])).toBe(`sh -c 'cd app && exec node scripts/zerops/app-host.mts'`);
  // The runtime tree travels as one release archive (scripts/zerops/pack-app-release.sh) and is unpacked into app/
  // before that unchanged start command, on every container start (scripts/zerops/unpack-app-release.sh).
  expect(serviceStrings(app, ['build', 'deployFiles'])).toStrictEqual(['.zerops-release']);
  const buildCommands = serviceStrings(app, ['build', 'buildCommands']);
  // One unit identity table per build, outside the checkout; the unit build and the host build both read it.
  const digests = 'ZEROPS_UNIT_DIGESTS=/tmp/zerops-unit-digests.tsv';
  const identities = buildCommands.indexOf(
    'cd app && sh scripts/zerops/build-app.sh --digests-only /tmp/zerops-unit-digests.tsv',
  );
  // The Outbox Worker host builds beside the pack (build-app.sh --outbox-host); app-release.test.mts runs both.
  expect(buildCommands.at(-1)).toBe(
    `sh app/scripts/zerops/pack-app-release.sh sh -c 'cd app && ${digests} sh scripts/zerops/build-app.sh --outbox-host'`,
  );
  // The tree without its left-out packages is proven before the pack (prove-app-runtime.test.mts runs the proof).
  expect(buildCommands.at(-2)).toBe('cd app && node scripts/zerops/prove-app-runtime.mts');
  const units = buildCommands.indexOf(`cd app && ${digests} sh scripts/zerops/build-app.sh`);
  expect(identities).toBeGreaterThan(-1);
  expect(units).toBeGreaterThan(identities);
  expect(units).toBeLessThan(buildCommands.length - 2);
  expect(serviceStrings(app, ['build', 'prepareCommands'])[0]).toBe('sudo apk add --no-cache curl tar unzip zstd');
  expect(serviceStrings(app, ['run', 'prepareCommands'])).toStrictEqual([APP_RELEASE_TOOLS]);
  expect(serviceStrings(app, ['run', 'initCommands'])).toStrictEqual([APP_RELEASE_UNPACK]);
  const pack = readFileSync(new URL('../zerops/pack-app-release.sh', import.meta.url), 'utf-8');
  expect(pack).toContain("list='app/scripts/zerops/app-runtime-paths.txt'");
  expect(pack).toContain('pack app "$@" $main_paths');
  expect(pack).toContain('pack outbox-worker-host "$host"');
  // Packed beside and renamed in; tar's status and the digest are checked (app-release.test.mts runs the failures).
  expect(pack).toContain(String.raw`printf '%s\n' "$digest" >"$staging/$name.tar.zst.sha256"`);
  expect(pack).toContain('mv "$staging" "$release"');
  expect(pack).toContain('cp app/scripts/zerops/unpack-app-release.sh "$staging/unpack.sh"');
  const unpack = readFileSync(new URL('../zerops/unpack-app-release.sh', import.meta.url), 'utf-8');
  // Digest first, then a scratch unpack renamed into place, then the archive removed.
  const order = [
    'if ! actual="$(sha256sum "$archive")"; then',
    'if ! { zstd -q -dc "$archive"; echo "$?" >"$status"; } | tar --extract --file - -C "$scratch" ||',
    'mv "$scratch/app" app',
    'rm -rf app.previous "$scratch"\nremove_archives',
  ].map((line) => unpack.lastIndexOf(line));
  expect(order.every((index) => index > -1)).toBe(true);
  expect(order.toSorted((left, right) => left - right)).toStrictEqual(order);
  for (const branch of [
    ['deploy', 'readinessCheck'],
    ['run', 'healthCheck'],
  ]) {
    // Probes use the loopback control port; the public port 3000 opens only once the host has published.
    expect(app.getIn([...branch, 'httpGet', 'port'])).toBe(3001);
  }
  expect(app.getIn(['run', 'healthCheck', 'httpGet', 'path'])).toBe('/_host/live');
  expect(app.getIn(['deploy', 'readinessCheck', 'httpGet', 'path'])).toBe('/_host/ready');
  expect(app.getIn(['deploy', 'readinessCheck', 'retryPeriod'])).toBe('10s');
});

it('starts the storefront from its standalone bundle and keeps the Shell URL in-project', () => {
  const storefront = serviceBlock(readZeropsDeploymentYaml(), 'storefront');

  expect(storefront).toContain('exec node akros-storefront/server.js');
  expect(storefront).toContain('ONTOS_SHELL_URL: http://app:3000');
});

it('deploys each storefront from the runner-built archive, checked against its setup, never building on Zerops', () => {
  const zeropsYaml = readZeropsDeploymentYaml();
  for (const [setup, pkg] of [
    ['storefront', 'akros-storefront'],
    ['n1', 'n1-storefront'],
  ] as const) {
    const service = serviceNode(zeropsYaml, setup);
    const commands = serviceStrings(service, ['build', 'buildCommands']);
    expect(commands.join('\n')).not.toMatch(/pnpm|next build|npm install/u);
    expect(commands[0]).toContain('test -f app/.zerops-storefront.tar.gz && test -f app/.zerops-storefront.json');
    expect(commands[1]).toContain(`m.setup !== "${setup}" || m.package !== "${pkg}" || m.archiveSha256 !== digest`);
    expect(commands[1]).toContain('m.arch !== process.arch || m.nativeAddons !== 0');
    expect(commands[2]).toBe(
      'mkdir -p app/.zerops/runtime && tar -xzf app/.zerops-storefront.tar.gz -C app/.zerops/runtime',
    );
    expect(commands[3]).toBe(`test -f 'app/.zerops/runtime/${pkg}/${pkg}/server.js'`);
    expect(serviceStrings(service, ['build', 'deployFiles'])).toStrictEqual([`app/.zerops/runtime/${pkg}`]);
    expect(service.getIn(['build', 'cache'])).toBeUndefined();
    expect(service.getIn(['run', 'start'])).toContain(
      `cd app/.zerops/runtime/${pkg} && HOSTNAME=0.0.0.0 exec node ${pkg}/server.js`,
    );
    // The old release keeps serving until the new one answers its readiness probe.
    expect(service.getIn(['deploy', 'temporaryShutdown'])).toBe(false);
    expect(service.getIn(['deploy', 'readinessCheck', 'retryPeriod'])).toBe('10s');
  }
});

it('ships checksum-pinned Bun with the native Node Shell default and no runtime download', () => {
  const app = serviceNode(readZeropsDeploymentYaml(), 'app');
  expect(serviceStrings(app, ['build', 'prepareCommands'])).toContain(
    'sh /build/source/app/scripts/install-zerops-bun.sh 1.4.4',
  );
  expect(serviceStrings(app, ['build', 'buildCommands'])).toContain(
    `mkdir -p 'app/.zerops/bun' && cp -a "$HOME/.local/bun-1.4.4/bin" 'app/.zerops/bun/'`,
  );
  // The boot record's directory ships with an empty record; the running container never creates it.
  expect(serviceStrings(app, ['build', 'buildCommands'])).toContain(
    `mkdir -p 'app/.zerops/state' && printf '[]' >'app/.zerops/state/module-credential-boots.json'`,
  );
  expect(app.getIn(['run', 'envVariables', 'ONTOS_SHELL_RUNTIME_DEFAULT'])).toBe('node');
  expect(app.getIn(['run', 'envVariables', 'ONTOS_SHELL_RUNTIME'])).toBeUndefined();
  // The only start-time step unpacks the release; nothing downloads a runtime.
  expect(serviceStrings(app, ['run', 'initCommands'])).toEqual([APP_RELEASE_UNPACK]);
  const installer = readFileSync(new URL('../install-zerops-bun.sh', import.meta.url), 'utf-8');
  expect(installer).toContain('bun-linux-x64-musl-baseline');
  expect(installer).toContain('6e9c37098b293920aed28bfb51ab240e26d23bfdd9bbfecb3ad428ac166549bc');
  // Zerops builds on Alpine and names no C library, so the installer's default stays the musl build.
  expect(installer).toContain(':-musl}');
  expect(installer).toContain('sha256sum -c -');
  expect(installer.indexOf('sha256sum -c -')).toBeLessThan(installer.indexOf('unzip -q'));
});

it('fails the application build whose Zephyr upload fails', () => {
  const app = serviceNode(readZeropsDeploymentYaml(), 'app');

  expect(app.getIn(['build', 'envVariables', 'ZE_FAIL_BUILD'])).toBe('true');
});

it('excludes compressed asset copies from both CI archives and the final Zerops package', () => {
  const deployIgnore = readFileSync(new URL('../../../.deployignore', import.meta.url), 'utf-8');
  // Every shard archive, built or reused, is packed by the one pack step (scripts/zerops/reuse-shard-units.sh).
  const workflow = readFileSync(stageWorkflowPath, 'utf-8');
  const shardPack = readFileSync(new URL('../zerops/reuse-shard-units.sh', import.meta.url), 'utf-8');
  expect(workflow).toContain('bash scripts/zerops/reuse-shard-units.sh pack "$RUNNER_TEMP/units.tar.zst" $units');
  expect(workflow).toContain('bash scripts/zerops/reuse-shard-units.sh reuse "$RUNNER_TEMP/zerops-unit-identities"');
  for (const extension of ['br', 'gz']) {
    expect(deployIgnore).toContain(`app/apps/*/dist/**/*.${extension}`);
    expect(deployIgnore).toContain(`app/verticals/*/dist/**/*.${extension}`);
    expect(shardPack).toContain(`--exclude='*.${extension}'`);
  }
});

it('bakes the public origins the app runs with into its bundles, including the AKROS storefront', () => {
  const app = serviceNode(readZeropsDeploymentYaml(), 'app');
  const buildApp = readFileSync(new URL('../zerops/build-app.sh', import.meta.url), 'utf-8');

  for (const key of ['ONTOS_PUBLIC_ORIGIN', 'ONTOS_STOREFRONT_ORIGIN', 'ONTOS_SHOP_STOREFRONT_ORIGIN']) {
    expect(app.getIn(['build', 'envVariables', key])).toBe(app.getIn(['run', 'envVariables', key]));
  }
  // Without it the merchandise and Shell bundles fall back to the local storefront (http://localhost:3070).
  expect(buildApp).toContain('export ULTRAMODERN_PUBLIC_URL_AKROS_STOREFRONT="$ONTOS_STOREFRONT_ORIGIN"');
  expect(buildApp).toContain('export ULTRAMODERN_PUBLIC_URL_SHOP_STOREFRONT="$ONTOS_SHOP_STOREFRONT_ORIGIN"');
});

it('uses native Alpine Node 26 for every Node build and runtime without a custom Node installation', () => {
  const zeropsYaml = readZeropsDeploymentYaml();
  const pnpm = /"packageManager": "pnpm@(?<pnpm>[^"+]+)"/u.exec(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf-8'),
  )?.groups?.pnpm;
  expect(pnpm).toBeDefined();
  for (const setup of ['storefront', 'n1', 'app']) {
    const service = serviceNode(zeropsYaml, setup);
    const block = serviceBlock(zeropsYaml, setup);
    expect(service.getIn(['build', 'base'])).toBe('alpine/nodejs@26');
    expect(service.getIn(['run', 'base'])).toBe('alpine/nodejs@26');
    // Only the app installs on Zerops; the storefronts arrive built from the runner (scripts/zerops/build-storefront.sh).
    const installsPnpm = serviceStrings(service, ['build', 'prepareCommands']).includes(
      `sudo npm install --global pnpm@${pnpm}`,
    );
    expect(installsPnpm).toBe(setup === 'app');
    // The app's runtime image adds only the tools that unpack its release archive.
    expect(serviceStrings(service, ['run', 'prepareCommands'])).toEqual(setup === 'app' ? [APP_RELEASE_TOOLS] : []);
    expect(serviceStrings(service, ['run', 'initCommands'])).toEqual(setup === 'app' ? [APP_RELEASE_UNPACK] : []);
    expect(block).not.toMatch(/install-zerops-node|\.local\/node-|\.zerops\/node|\/node\/bin|libatomic/u);
    expect(block).toMatch(/start: sh -c '.*exec node /u);
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

it('declares the import list of the data plane, the migrator secrets, the app and the three storefronts only', () => {
  const { services } = Schema.decodeUnknownSync(ZeropsImportSchema)(parse(readFileSync(zeropsImportPath, 'utf-8')));

  expect(
    services.map(
      ({ enableSubdomainAccess = false, hostname, type }) => `${hostname} ${type} ${String(enableSubdomainAccess)}`,
    ),
  ).toStrictEqual([
    'db18 postgresql:single@18 false',
    'spicedb docker@26.1.5 false',
    'migrator alpine/nodejs@26 false',
    'app alpine/nodejs@26 true',
    'storefront alpine/nodejs@26 true',
    'shop alpine/nodejs@26 true',
    'n1 alpine/nodejs@26 true',
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

it('keeps the application at 4 to 8 GiB and four to eight dedicated CPUs in exactly one container', () => {
  const services = Schema.decodeUnknownSync(Schema.instanceOf(YAMLSeq))(
    parseDocument(readFileSync(zeropsImportPath, 'utf-8')).get('services', true),
  );
  const app = Schema.decodeUnknownSync(Schema.instanceOf(YAMLMap))(
    services.items.find((service) => isMap(service) && service.get('hostname') === 'app'),
  );

  expect(app.getIn(['verticalAutoscaling', 'minRam'])).toBe(4);
  expect(app.getIn(['verticalAutoscaling', 'maxRam'])).toBe(8);
  expect(app.getIn(['verticalAutoscaling', 'minFreeRamGB'])).toBe(0.5);
  expect(app.getIn(['verticalAutoscaling', 'cpuMode'])).toBe('DEDICATED');
  expect(app.getIn(['verticalAutoscaling', 'minCpu'])).toBe(4);
  expect(app.getIn(['verticalAutoscaling', 'maxCpu'])).toBe(8);
  expect(app.get('minContainers')).toBe(1);
  expect(app.get('maxContainers')).toBe(1);
});

it('runs the pseudonymous demo e-shop on shared CPU and pushes it from the storefront setup', () => {
  const services = Schema.decodeUnknownSync(Schema.instanceOf(YAMLSeq))(
    parseDocument(readFileSync(zeropsImportPath, 'utf-8')).get('services', true),
  );
  const shop = Schema.decodeUnknownSync(Schema.instanceOf(YAMLMap))(
    services.items.find((service) => isMap(service) && service.get('hostname') === 'shop'),
  );
  const workflow = readFileSync(stageWorkflowPath, 'utf-8');

  expect(shop.getIn(['verticalAutoscaling', 'cpuMode'])).toBe('SHARED');
  expect(shop.getIn(['verticalAutoscaling', 'maxRam'])).toBe(1);
  expect(shop.get('maxContainers')).toBe(1);
  expect(workflow).toContain('uses: ./.github/actions/deliver-stage');
  expect(readFileSync(deliverStageActionPath, 'utf-8')).toContain('bash app/scripts/zerops/stage-push.sh start shop');
  const stagePush = readFileSync(stagePushPath, 'utf-8');
  expect(stagePush).toContain(
    `shop) printf '%s storefront' "\${ZEROPS_SHOP_STOREFRONT_SERVICE_ID:?shop service id is required}"`,
  );
  expect(stagePush).toContain('push-service.sh" "$id" "$setup" "$GITHUB_SHA"');
});

it('runs the N1 e-shop on one minimal service of its own, from the n1 setup, with no AKROS or shop identity', () => {
  const services = Schema.decodeUnknownSync(Schema.instanceOf(YAMLSeq))(
    parseDocument(readFileSync(zeropsImportPath, 'utf-8')).get('services', true),
  );
  const n1 = Schema.decodeUnknownSync(Schema.instanceOf(YAMLMap))(
    services.items.find((service) => isMap(service) && service.get('hostname') === 'n1'),
  );
  const block = serviceBlock(readZeropsDeploymentYaml(), 'n1');
  const workflow = readFileSync(stageWorkflowPath, 'utf-8');
  const delivery = readFileSync(deliverStageActionPath, 'utf-8');
  const stagePush = readFileSync(stagePushPath, 'utf-8');

  expect(n1.getIn(['verticalAutoscaling', 'cpuMode'])).toBe('SHARED');
  expect(n1.getIn(['verticalAutoscaling', 'maxRam'])).toBe(1);
  expect(n1.get('minContainers')).toBe(1);
  expect(n1.get('maxContainers')).toBe(1);
  expect(block).not.toMatch(/akros-storefront|ONTOS_AKROS_STOREFRONT_API_KEY|DATABASE_URL|SMTP_|PAYMENT_|SHIPPING_/u);
  expect(block).toContain('ONTOS_SHELL_URL: http://app:3000');
  expect(block).toContain('test -n "$ONTOS_N1_STOREFRONT_API_KEY"');
  expect(stagePush).toContain(`n1) printf '%s n1' "\${ZEROPS_N1_STOREFRONT_SERVICE_ID:?n1 service id is required}"`);
  expect(workflow).toContain(`n1-storefront-api-key: \${{ secrets.ONTOS_N1_STOREFRONT_API_KEY }}`);
  expect(delivery).toContain(`ONTOS_N1_STOREFRONT_API_KEY: \${{ inputs.n1-storefront-api-key }}`);
  expect(delivery).toContain('route-stage-domains.sh ontos-stage-n1.web-revolution.cz');
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

const DeliveryStepSchema = Schema.Struct({
  'continue-on-error': Schema.optional(Schema.Boolean),
  env: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  id: Schema.optional(Schema.String),
  if: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type DeliveryStep = typeof DeliveryStepSchema.Type;
const stageProofsPath = new URL('../zerops/stage-proofs.sh', import.meta.url);
const PROOFS_START = 'bash scripts/zerops/stage-proofs.sh start';
/** The delivery every run shares (.github/actions/deliver-stage), from its secret syncs to its last proof. */
const deliverySteps = (): readonly DeliveryStep[] =>
  Schema.decodeUnknownSync(Schema.Struct({ runs: Schema.Struct({ steps: Schema.Array(DeliveryStepSchema) }) }))(
    parse(readFileSync(deliverStageActionPath, 'utf-8')),
  ).runs.steps;
const stageJobs = () =>
  Schema.decodeUnknownSync(
    Schema.Struct({
      jobs: Schema.Struct({
        deliver: Schema.Struct({ steps: Schema.Array(DeliveryStepSchema) }),
        deliver_app: Schema.Struct({ steps: Schema.Array(DeliveryStepSchema) }),
      }),
    }),
  )(parse(readFileSync(stageWorkflowPath, 'utf-8'))).jobs;

it('installs Chromium for the warm-up client before running its bounded browser pass', () => {
  const steps = deliverySteps();
  const install = steps.findIndex(
    ({ run }) =>
      run?.includes('pnpm --config.verify-deps-before-run=false exec playwright-core install chromium') === true,
  );
  // The proofs start from stage-proofs.sh, which runs the warm-up.
  const starts = steps.flatMap(({ run }, index) => (run === PROOFS_START ? [index] : []));
  expect(install).toBeGreaterThanOrEqual(0);
  expect(starts).toHaveLength(2);
  for (const start of starts) {
    expect(start).toBeGreaterThan(install);
  }
  expect(readFileSync(stageProofsPath, 'utf-8')).toContain('mise exec -- node scripts/ops/stage-warmup.mts');
});

it('marks the attempt after the plan is retained and before any remote mutation, in both delivering jobs', () => {
  const jobs = stageJobs();
  for (const job of [jobs.deliver, jobs.deliver_app]) {
    const index = (name: string) => job.steps.findIndex((step) => step.name === name);
    const mark = job.steps[index(MUTATION_MARKER)];
    // The mark refuses a remote head that moved on: a run never deploys an older branch head.
    expect(mark?.run).toContain('test "$current_head" = "$GITHUB_SHA"');
    const deliver = job.steps.findIndex(({ uses }) => uses === DELIVER_STAGE);
    expect(deliver).toBeGreaterThan(index(MUTATION_MARKER));
    expect(mark?.if).toBe(job.steps[deliver]?.if);
    // Nothing before the mark syncs a secret or pushes.
    for (const step of job.steps.slice(0, index(MUTATION_MARKER))) {
      expect(step.run ?? '', step.name).not.toMatch(/sync-service-secret|stage-push|push-service/u);
    }
  }
  const { deliver } = jobs;
  const plan = deliver.steps.findIndex(({ name }) => name === 'Retain the delivery decision');
  expect(plan).toBeGreaterThan(-1);
  expect(plan).toBeLessThan(deliver.steps.findIndex(({ name }) => name === MUTATION_MARKER));
  // The delivery syncs every secret before its first push, and every push checks the branch head itself.
  const steps = deliverySteps();
  const sync = steps.findIndex(({ run }) => run?.includes('sync-service-secret.sh') === true);
  const firstPush = steps.findIndex(({ run }) => run?.includes('stage-push.sh start') === true);
  expect(sync).toBe(0);
  expect(firstPush).toBeGreaterThan(sync);
  expect(readFileSync(stagePushPath, 'utf-8')).toContain('if [ "$head" != "$GITHUB_SHA" ]; then');
  // The live proofs stay mandatory: their verdict has no condition, and fails when they never started.
  const finish = steps.find(({ run }) => run === 'bash scripts/zerops/stage-proofs.sh finish');
  expect(finish).toBeDefined();
  expect(finish?.if).toBeUndefined();
  expect(finish?.['continue-on-error']).toBeUndefined();
  const proofs = readFileSync(stageProofsPath, 'utf-8');
  for (const proof of [
    'scripts/ops/stage-warmup.mts',
    'scripts/zerops/verify-service.mjs app',
    'scripts/demo/prove-mcp-oauth.mts',
  ]) {
    expect(proofs, proof).toContain(`mise exec -- node ${proof}`);
  }
  for (const step of steps) {
    expect(step.with?.['fail-on-cache-miss'], step.name ?? step.uses).not.toBe(true);
  }
  expect(readFileSync(stageWorkflowPath, 'utf-8')).not.toContain('actions/caches?key=');
});

it('keeps the worker only with its closure, all hosted identities, materializer inputs and flags proved', () => {
  const script = readFileSync(new URL('../zerops/build-app.sh', import.meta.url), 'utf-8');
  const digest = readFileSync(new URL('../zerops/outbox-build-digest.mjs', import.meta.url), 'utf-8');
  expect(script).toContain("echo 'kept outbox-worker-host (inputs unchanged)'");
  expect(script).toContain('worker_cache/node_modules');
  expect(digest).toContain('artifact.sourceInputs');
  expect(digest).toContain('artifact.ownerBuildIdentities');
  expect(digest).toContain('Missing owner digest');
  expect(digest).toContain('Worker owner build identity changed');
  expect(digest).toContain('--app outbox-worker-host --package app --package-dir . --worker');
  expect(digest).toContain('scripts/materialize-outbox-worker.mjs');
  expect(digest).toContain('pnpm-lock.yaml');
});

it('keeps every unit of an app push for the next one, building those the Zerops build builds while the app deploys', () => {
  const steps = deliverySteps();
  const at = (predicate: (step: DeliveryStep) => boolean) => steps.findIndex(predicate);
  const appPush = at(({ id }) => id === 'push-app');
  const aside = at(({ name }) => name === 'Set the pushed unit builds aside');
  const install = at(({ name }) => name === INSTALL_WORKSPACE);
  const build = at(({ name }) => name === 'Build the units the Zerops build builds, for the next push');
  const kept = at(({ with: options }) => options?.name === 'zerops-units-0');
  const storefront = at(({ run }) => run?.includes('build-storefront.sh') === true);
  const appWait = at(({ run }) => run === 'bash app/scripts/zerops/stage-push.sh wait app');
  // After the app upload and before the wait for it, so off the delivery's critical path; on a clean checkout (the
  // pushed archive set aside, no storefront build yet); kept only after the build.
  expect(appPush).toBeGreaterThanOrEqual(0);
  expect(aside).toBeGreaterThan(appPush);
  expect(steps[aside]?.run).toContain('mv app/.zerops-prebuilt.tar.zst "$RUNNER_TEMP/units-keep/units.tar.zst"');
  expect(install).toBeGreaterThan(aside);
  expect(build).toBeGreaterThan(install);
  expect(storefront).toBeGreaterThan(build);
  expect(kept).toBeGreaterThan(build);
  expect(appWait).toBeGreaterThan(kept);
  expect(steps[build]?.run).toContain('git status --porcelain --untracked-files=all');
  expect(steps[build]?.run).toContain('pack-prebuilt-units.sh "$DISTS" "$RUNNER_TEMP/units-keep/units.tar.zst"');
  // The same declared build environment as the identity step, so each build carries this commit's identity.
  const { deliver } = stageJobs();
  const identities = deliver.steps.find(({ name }) => name === 'Write the unit identities and shard lists');
  expect(Object.keys(identities?.env ?? {}).length).toBeGreaterThan(0);
  for (const [variable, value] of Object.entries(identities?.env ?? {})) {
    expect(steps[build]?.env?.[variable], variable).toBe(value);
  }
  expect(steps[build]?.run).toContain('zerops-unit-identities/digests.tsv');
  // The units it builds are the ones the front path could not lend.
  const delivery = deliver.steps.find(({ uses }) => uses === DELIVER_STAGE);
  expect(delivery?.with?.['build-units']).toBe(`\${{ steps.taken.outputs.missing }}`);
});

/** Lines that run, without comments: a comment may name node or pnpm. */
const code = (source: string) =>
  source
    .split('\n')
    .filter((line) => !/^\s*#/u.test(line))
    .join('\n');
/** What exists only once a toolchain is installed: none of it may run before the app upload. */
const TOOLCHAIN = /\b(?:mise|pnpm|npm|npx|node|zcli|playwright)\b/u;
/**
 * Every script a command runs (bash, sh), sources (source, .) or assigns to run, and every script those reach in turn
 * (stage-push.sh starts push-service.sh).
 */
const scriptsReachedBy = (command: string): readonly string[] => {
  const reached = new Set<string>();
  const visit = (source: string) => {
    for (const [, name] of source.matchAll(
      /(?:\b(?:bash|sh|source) +"?|(?:^|[\s;&|(])\. +"?|=)(?:\$script_dir\/|(?:app\/)?scripts\/zerops\/)(?<script>[\w-]+\.sh)/gmu,
    )) {
      if (name === undefined || reached.has(name)) {
        continue;
      }
      reached.add(name);
      visit(code(readFileSync(new URL(`../zerops/${name}`, import.meta.url), 'utf-8')));
    }
  };
  visit(command);
  return [...reached];
};
/** Where a job runs the shared delivery. */
const delivery = (job: { steps: readonly DeliveryStep[] }) => job.steps.findIndex(({ uses }) => uses === DELIVER_STAGE);

it('pushes the app before any install: nothing up to the upload needs the toolchain, and each caller declares its own', () => {
  const steps = deliverySteps();
  const index = (name: string) => steps.findIndex((step) => step.name === name);
  const appPush = steps.findIndex(({ id }) => id === 'push-app');
  const setup = index('Set up the toolchain and install the app workspace');
  const install = index(INSTALL_WORKSPACE);
  // A caller that installed nothing gets the toolchain, the pnpm store and the whole workspace here; one that ran the
  // root importer install gets the whole workspace from its store. Exactly one of the two runs.
  expect(steps[setup]?.uses).toBe(INSTALL_APP);
  expect(steps[setup]?.with?.['install-args']).toBe('--trust-lockfile');
  expect(steps[setup]?.if).toBe("inputs.toolchain == 'none'");
  expect(steps[install]?.if).toBe("inputs.toolchain == 'installed'");
  expect(steps[0]?.run).toContain('installed | none) ;;');
  expect(appPush).toBeGreaterThanOrEqual(0);
  const firstInstall = Math.min(setup, install);
  expect(firstInstall).toBeGreaterThan(appPush);
  // The boot reader starts right after the upload in both paths (a reader started after the new boot loses it) and
  // is the one step before the install that brings its own tool: the pinned zcli, from the npm on PATH there.
  const reader = index("Read the new app container's boot stages");
  expect(reader).toBe(appPush + 1);
  expect(steps[reader]?.run).toBe('bash app/scripts/zerops/app-boot-stages.sh start');
  const readerScript = code(readFileSync(new URL('../zerops/app-boot-stages.sh', import.meta.url), 'utf-8'));
  expect(readerScript.match(/\bnpm install\b/gu)).toEqual(['npm install']);
  expect(readerScript).toContain('npm install --global @zerops/zcli@1.1.3');
  expect(readerScript).not.toMatch(/\b(?:mise|pnpm|npx|playwright)\b/u);
  // Nothing else before the install runs the toolchain or its tools, in the step or in any script it reaches.
  const reached = new Set<string>();
  for (const step of steps.slice(0, firstInstall).filter((_, position) => position !== reader)) {
    expect(step.uses, step.name).toBeUndefined();
    expect(code(step.run ?? ''), step.name).not.toMatch(TOOLCHAIN);
    for (const script of scriptsReachedBy(step.run ?? '')) {
      reached.add(script);
    }
  }
  for (const script of reached) {
    expect(code(readFileSync(new URL(`../zerops/${script}`, import.meta.url), 'utf-8')), script).not.toMatch(TOOLCHAIN);
  }
  expect([...reached].toSorted()).toEqual([
    'pack-prebuilt-units.sh',
    'push-service.sh',
    'stage-push.sh',
    'sync-service-secret.sh',
  ]);
  // The job after the unit builds installs nothing before it pushes; the planning job installed the root importer.
  const { deliver, deliver_app: deliverApp } = stageJobs();
  expect(deliverApp.steps[delivery(deliverApp)]?.with?.toolchain).toBe('none');
  for (const step of deliverApp.steps.slice(0, delivery(deliverApp))) {
    expect(step.uses ?? '', step.name).not.toBe(INSTALL_APP);
    expect(code(step.run ?? ''), step.name).not.toMatch(TOOLCHAIN);
  }
  expect(deliver.steps[delivery(deliver)]?.with?.toolchain).toBe('installed');
  const planInstall = deliver.steps.findIndex(({ uses }) => uses === INSTALL_APP);
  expect(planInstall).toBeGreaterThanOrEqual(0);
  expect(planInstall).toBeLessThan(delivery(deliver));
});

it('plans from the run history with only the root importer and a depth-1 checkout', () => {
  const { steps } = stageJobs().deliver;
  expect(steps.find(({ uses }) => uses?.startsWith('actions/checkout@') === true)?.with?.['fetch-depth']).toBe(1);
  expect(steps.find(({ uses }) => uses === INSTALL_APP)?.with?.['install-args']).toBe('--trust-lockfile --filter app');
  // The changes come from GitHub's compare API: the checkout the app push ships stays shallow.
  const source = readFileSync(stageWorkflowPath, 'utf-8');
  expect(source).not.toContain('--unshallow');
  // No delivery state lives in the Actions cache, which evicts at will.
  expect(source).not.toMatch(/zerops-stage-(?:delivery|attempt)-|zerops-planner-modules-/u);
  const history = steps.findIndex(({ run }) => run?.includes('read-delivery-history.sh') === true);
  const plan = steps.findIndex(({ run }) => run?.includes('delivery-plan-cli.mts plan') === true);
  expect(history).toBeGreaterThanOrEqual(0);
  expect(plan).toBeGreaterThan(history);
});

const verificationSteps = deliverySteps;

it('installs the full verification workspace and caches the frozen browser graph plus image-specific apt archives', () => {
  const steps = verificationSteps();
  // The whole workspace, once the app upload is done, from the store of the caller's root importer install.
  expect(steps.find(({ name }) => name === INSTALL_WORKSPACE)?.run).toBe(
    'mise exec -- pnpm install --frozen-lockfile --trust-lockfile',
  );
  const versions = steps.find(({ id }) => id === 'verification-browser-versions');
  expect(versions?.run).toContain(
    'pnpm --config.verify-deps-before-run=false --filter @app/shell-super-app exec playwright --version',
  );
  expect(versions?.run).toContain('pnpm --config.verify-deps-before-run=false exec playwright-core --version');
  const restore = steps.findIndex(({ id }) => id === 'verification-browsers');
  expect(steps[restore]?.with?.key).toContain("hashFiles('app/pnpm-lock.yaml', 'app/.mise.toml')");
  expect(steps.find(({ id }) => id === 'chromium-debs')?.run).toContain('$ImageOS-$ImageVersion-');
  const aptRestore = steps.findIndex(({ id }) => id === 'chromium-debs-cache');
  const aptInstall = steps.findIndex(({ run }) => run?.includes('playwright install --with-deps chromium') === true);
  const aptSeed = steps.findIndex(({ run }) => run?.includes('sudo find ~/.cache/playwright-apt-debs') === true);
  expect(aptRestore).toBeGreaterThanOrEqual(0);
  expect(aptSeed).toBeGreaterThan(aptRestore);
  expect(aptInstall).toBeGreaterThan(aptSeed);
  expect(steps[aptInstall]?.if).toBeUndefined();
  expect(steps[aptSeed]?.run).toContain('/var/cache/apt/archives/');
  for (const command of ['playwright install --with-deps chromium', 'playwright-core install chromium']) {
    const download = steps.findIndex(({ run }) => run?.includes(command) === true);
    expect(download).toBeGreaterThan(restore);
    expect(steps[download]?.if).toBeUndefined();
  }
});

it('counts a module as a caller by its declared requirement callers or registered-workload calls', () => {
  const requirement = {};
  expect(declaresModuleCalls({})).toBe(false);
  expect(declaresModuleCalls({ requirements: { operations: [requirement] } })).toBe(false);
  expect(declaresModuleCalls({ requirements: { operations: [{ ...requirement, callers: [] }] } })).toBe(false);
  expect(
    declaresModuleCalls({ requirements: { operations: [{ ...requirement, callers: [{ kind: 'person' }] }] } }),
  ).toBe(true);
  expect(declaresModuleCalls({ registeredWorkloadCalls: [{ workloadKey: 'commerce.catalog.read' }] })).toBe(true);
});
