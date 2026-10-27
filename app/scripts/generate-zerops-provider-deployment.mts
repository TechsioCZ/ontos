import { NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Effect, FileSystem, ManagedRuntime, Order, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { isMap, isNode, isScalar, isSeq, parse, parseDocument } from 'yaml';
import type { YAMLMap } from 'yaml';

import { PARTY_REGISTRY_REQUEST_SECRET, zeropsIdentityDatabaseUrl } from './ops/database-identity-secrets.mts';
import { readDevelopmentPorts } from './topology-development-ports.mjs';

const importsBegin = '  # <generated-vertical-provider-imports>';
const importsEnd = '  # </generated-vertical-provider-imports>';
const providerRuntimeBase = 'nodejs@24';
const TopologySchema = Schema.fromJsonString(
  Schema.Struct({
    verticals: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        package: Schema.String,
        path: Schema.String,
      }),
    ),
  }),
);

class ProviderDeploymentInvalid extends Schema.TaggedError<ProviderDeploymentInvalid>()('ProviderDeploymentInvalid', {
  reason: Schema.String,
}) {}

const invalid = (reason: string) => new ProviderDeploymentInvalid({ reason });
const invalidDeploymentYaml = 'Invalid Zerops deployment YAML';

/** Parses exact setup identities without depending on scalar quoting, comments, or service order. */
export const readZeropsDeployment = (source: string) =>
  Effect.gen(function* readDeployment() {
    const document = yield* Effect.try({
      catch: () => invalid(invalidDeploymentYaml),
      try: () => parseDocument(source),
    });
    if (document.errors.length > 0 || !isMap(document.contents)) {
      return yield* invalid(invalidDeploymentYaml);
    }
    const setups = document.contents.get('zerops', true);
    if (!isSeq(setups)) {
      return yield* invalid(invalidDeploymentYaml);
    }
    const services = new Map<string, YAMLMap>();
    for (const service of setups.items) {
      if (!isMap(service)) {
        return yield* invalid('Invalid Zerops deployment setup');
      }
      const id = service.get('setup');
      if (!Schema.is(Schema.String)(id) || id.length === 0) {
        return yield* invalid('Invalid Zerops deployment setup');
      }
      if (services.has(id)) {
        return yield* invalid(`Duplicate Zerops deployment setup: ${id}`);
      }
      services.set(id, service);
    }
    const canonical = yield* Effect.try({
      catch: () => invalid('Cannot serialize Zerops deployment YAML'),
      try: () => document.toString({ lineWidth: 0 }),
    });
    return { canonical, document, services, setups, source };
  });

/** Retains the original bytes when the generator made no effective edit. */
export const renderZeropsDeployment = (deployment: Effect.Success<ReturnType<typeof readZeropsDeployment>>) =>
  Effect.try({
    catch: () => invalid('Cannot serialize Zerops deployment YAML'),
    try: () => {
      const rendered = deployment.document.toString({ lineWidth: 0 });
      return rendered === deployment.canonical ? deployment.source : rendered;
    },
  });

const cloneYamlValue = (value: YAMLMap['items'][number]['value']) => (isNode(value) ? value.clone() : value);

/** Adds defaults only; owner-adapted settings and literal provider references remain intact. */
const mergeDeploymentDefaults = (target: YAMLMap, defaults: YAMLMap): void => {
  for (const { key, value } of defaults.items) {
    const name = isScalar(key) ? key.value : key;
    if (!Schema.is(Schema.String)(name)) {
      continue;
    }
    const existing = target.get(name, true);
    if (existing === undefined) {
      target.set(name, cloneYamlValue(value));
    } else if (isMap(existing) && isMap(value)) {
      mergeDeploymentDefaults(existing, value);
    }
  }
};

const generatedCommandIdentity = (command: string): string => {
  if (command.includes('pnpm install --frozen-lockfile')) {
    return 'workspace-install';
  }
  for (const script of [
    'install-zerops-node.sh',
    'verify-zerops-workspace-install.mts',
    'zerops:materialize',
    'topology/reference-topology.json',
    'topology/local-overlays/development.json',
  ]) {
    if (command.includes(script)) {
      return script;
    }
  }
  if (/pnpm --filter .+ run build$/u.test(command)) {
    return 'owner-build';
  }
  if (command.startsWith("mkdir 'app/.zerops/runtime/") && command.includes('cp -a "$HOME/.local/node-')) {
    return 'bundled-node';
  }
  return command;
};

/** Refreshes managed commands in place while retaining extra owner/operator hooks. */
const mergeDeploymentCommands = (target: YAMLMap, defaults: YAMLMap, key: string) =>
  Effect.gen(function* mergeCommands() {
    const desired = defaults.getIn(['build', key], true);
    const current = target.getIn(['build', key], true);
    if (!isSeq(desired) || !isSeq(current)) {
      return yield* Effect.void;
    }
    const commands = new Map<string, YAMLMap['items'][number]['value']>();
    for (const item of desired.items) {
      if (!isScalar(item) || !Schema.is(Schema.String)(item.value)) {
        return yield* invalid('Invalid generated build command');
      }
      commands.set(generatedCommandIdentity(item.value), item);
    }
    const retained = new Set<string>();
    for (const [index, item] of current.items.entries()) {
      if (!isScalar(item) || !Schema.is(Schema.String)(item.value)) {
        return yield* invalid('Invalid Zerops build command');
      }
      const identity = generatedCommandIdentity(item.value);
      const replacement = commands.get(identity);
      if (replacement !== undefined) {
        if (!isScalar(replacement) || item.value !== replacement.value) {
          current.items[index] = cloneYamlValue(replacement);
        }
        retained.add(identity);
      }
    }
    for (const [identity, item] of commands) {
      if (!retained.has(identity)) {
        current.add(cloneYamlValue(item));
      }
    }
    return yield* Effect.void;
  });

/** Updates only the primary runtime port, retaining extra owner ports and protocols. */
const updateDeploymentPorts = (target: YAMLMap, defaults: YAMLMap, previousPort: string | number | undefined) =>
  Effect.gen(function* updatePorts() {
    const desiredPorts = defaults.getIn(['run', 'ports'], true);
    const ports = target.getIn(['run', 'ports'], true);
    if (isSeq(desiredPorts) && isSeq(ports)) {
      for (const desired of desiredPorts.items) {
        if (!isMap(desired)) {
          return yield* invalid('Invalid generated runtime port');
        }
        const expected = desired.get('port');
        const existing = ports.items.find(
          (item) => isMap(item) && (String(item.get('port')) === String(previousPort) || item.get('port') === expected),
        );
        if (isMap(existing)) {
          existing.set('port', expected);
        } else {
          ports.add(cloneYamlValue(desired));
        }
      }
    }
    return yield* Effect.void;
  });

/**
 * Updates one known setup in place. Only identity/runtime plumbing is authoritative; other custom
 * fields, commands, extra ports, and deployment settings retain their original owner and order.
 */
export const updateZeropsService = (target: YAMLMap, defaults: YAMLMap) =>
  Effect.gen(function* updateService() {
    const previousPort = yield* Schema.decodeUnknownEffect(
      Schema.Union([Schema.String, Schema.Number, Schema.Undefined]),
    )(target.getIn(['run', 'envVariables', 'PORT'])).pipe(
      Effect.mapError(() => invalid('Invalid Zerops runtime port')),
    );
    mergeDeploymentDefaults(target, defaults);
    yield* mergeDeploymentCommands(target, defaults, 'prepareCommands');
    yield* mergeDeploymentCommands(target, defaults, 'buildCommands');
    for (const path of [
      ['setup'],
      ['run', 'start'],
      ['deploy', 'readinessCheck', 'httpGet', 'port'],
      ['deploy', 'readinessCheck', 'httpGet', 'path'],
      ['run', 'healthCheck', 'httpGet', 'port'],
      ['run', 'healthCheck', 'httpGet', 'path'],
    ]) {
      const value = defaults.getIn(path, true);
      if (value !== undefined && target.getIn(path) !== (isScalar(value) ? value.value : value)) {
        target.setIn(path, cloneYamlValue(value));
      }
    }
    const environment = defaults.getIn(['run', 'envVariables'], true);
    if (isMap(environment)) {
      for (const { key, value } of environment.items) {
        const name = isScalar(key) ? key.value : key;
        if (
          Schema.is(Schema.String)(name) &&
          (/^(?:PORT|OUTBOX_WORKER_HEALTH_PORT|ULTRAMODERN_ZEROPS_SERVICE|VERTICAL_[A-Z_]+_PORT)$/u.test(name) ||
            name.endsWith('DATABASE_URL'))
        ) {
          const path = ['run', 'envVariables', name];
          if (target.getIn(path) !== (isScalar(value) ? value.value : value)) {
            target.setIn(path, cloneYamlValue(value));
          }
        }
      }
    }
    yield* updateDeploymentPorts(target, defaults, previousPort);
    const files = target.getIn(['build', 'deployFiles'], true);
    const desiredFiles = defaults.getIn(['build', 'deployFiles'], true);
    if (isSeq(files) && isSeq(desiredFiles)) {
      const present = new Set(files.items.filter(isScalar).map((item) => item.value));
      for (const item of desiredFiles.items) {
        if (isScalar(item) && !present.has(item.value)) {
          files.add(item.clone());
          present.add(item.value);
        }
      }
    }
    return yield* Effect.void;
  });

interface ProviderVertical {
  readonly id: string;
  readonly package: string;
  readonly path: string;
  readonly port: number;
}

const EnvironmentEntryOrder = Order.mapInput(Order.String, ([key]: readonly [string, string]) => key);

const SHARED_RUNTIME_DATABASE_URL = `postgresql://ontos_runtime:\${db18_password}@\${db18_hostname}:\${db18_port}/\${db18_dbName}`;

/**
 * The database URL environment of one provider: Party Registry connects only as its dedicated request
 * identity (design D11); every other provider keeps the shared runtime role.
 */
const providerDatabaseEnvironment = (id: string): readonly (readonly [string, string])[] =>
  id === 'party-registry'
    ? [[PARTY_REGISTRY_REQUEST_SECRET.identity.urlKey, zeropsIdentityDatabaseUrl(PARTY_REGISTRY_REQUEST_SECRET, id)]]
    : [['DATABASE_URL', SHARED_RUNTIME_DATABASE_URL]];

const isPort = (port: number): boolean => Number.isInteger(port) && port >= 1 && port <= 65_535;

/** Joins reference-topology providers with their development-overlay ports. */
export const readZeropsProviderTopology = (root: string) =>
  Effect.gen(function* readProviderTopology() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const topology = yield* Schema.decodeUnknownEffect(TopologySchema)(
      yield* fs.readFileString(path.join(root, 'topology/reference-topology.json')),
    );
    const ports = yield* readDevelopmentPorts(root);
    const verticals: ProviderVertical[] = [];
    for (const vertical of topology.verticals) {
      const port = ports[vertical.id];
      if (port === undefined) {
        return yield* invalid(`Missing development port for topology provider: ${vertical.id}`);
      }
      verticals.push({ ...vertical, port });
    }
    return { verticals };
  });

export interface ZeropsToolchain {
  readonly node: string;
  readonly pnpm: string;
}

const renderProvider = (
  vertical: ProviderVertical,
  priceGroupCatalogBaseUrl: string | undefined,
  toolchain: ZeropsToolchain,
) =>
  Effect.gen(function* renderProviderEffect() {
    const { id, package: packageName, path: packageDir } = vertical;
    if (
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id) ||
      packageName !== `@app/${id}` ||
      packageDir !== `verticals/${id}`
    ) {
      return yield* invalid(`Invalid topology provider identity: ${id}`);
    }
    const { port } = vertical;
    if (!isPort(port)) {
      return yield* invalid(`Invalid topology provider port: ${id}`);
    }
    const readiness = `/${id}-api/${id}/readiness`;
    const runtime = `app/.zerops/runtime/${id}`;
    const portKey = `VERTICAL_${id.replaceAll('-', '_').toUpperCase()}_PORT`;
    const environment: (readonly [string, string])[] = [
      ...providerDatabaseEnvironment(id),
      ['NODE_ENV', 'production'],
      ['PORT', `'${port}'`],
      ['SPICEDB_CA_CERT', `\${spicedb_SPICEDB_GRPC_TLS_CERT}`],
      ['SPICEDB_ENDPOINT', "'spicedb:50051'"],
      ['SPICEDB_PRESHARED_KEY', `\${spicedb_SPICEDB_GRPC_PRESHARED_KEY}`],
      ['ULTRAMODERN_DEPLOYMENT_ENVIRONMENT', 'stage'],
      ['ULTRAMODERN_ZEROPS_SERVICE', id],
      [portKey, `'${port}'`],
    ];
    if (id === 'commerce-customer-context' && priceGroupCatalogBaseUrl !== undefined) {
      environment.push(['ONTOS_PRICE_GROUP_CATALOG_BASE_URL', `'${priceGroupCatalogBaseUrl}'`]);
    }
    const renderedEnvironment = EffectArray.sort(environment, EnvironmentEntryOrder)
      .map(([key, value]) => `        ${key}: ${value}`)
      .join('\n');
    const nodeBin = `$HOME/.local/node-${toolchain.node}/bin`;
    return `  - setup: '${id}'
    build:
      base: 'alpine@3.23'
      envVariables:
        # Zephyr uploads only when the deploy provides ZE_CI_TOKEN; a failed upload must fail the build.
        ZE_FAIL_BUILD: 'true'
      prepareCommands:
        - sudo apk add --no-cache curl libstdc++
        - sh /build/source/app/scripts/install-zerops-node.sh ${toolchain.node} ${toolchain.pnpm}
      buildCommands:
        - cd app && PATH="${nodeBin}:$PATH" pnpm install --frozen-lockfile
        - cd app && PATH="${nodeBin}:$PATH" node scripts/verify-zerops-workspace-install.mts
        - cd app && NODE_OPTIONS=--max-old-space-size=4096 ULTRAMODERN_SOURCE_REVISION="$(git rev-parse HEAD)" PATH="${nodeBin}:$PATH" pnpm --filter '${packageName}' run build
        - cd app && PATH="${nodeBin}:$PATH" pnpm run zerops:materialize --app '${id}' --package '${packageName}' --package-dir '${packageDir}'
        - cp 'app/topology/reference-topology.json' '${runtime}/topology.json'
        - cp 'app/topology/local-overlays/development.json' '${runtime}/local-overlay.json'
        - mkdir '${runtime}/node' && cp -a "$HOME/.local/node-${toolchain.node}/bin" "$HOME/.local/node-${toolchain.node}/lib" '${runtime}/node/'
      deployFiles:
        - '${runtime}'
    deploy:
      temporaryShutdown: false
      readinessCheck:
        httpGet:
          port: ${port}
          path: '${readiness}'
        failureTimeout: 3m
        retryPeriod: 10s
    run:
      base: '${providerRuntimeBase}'
      ports:
        - port: ${port}
          protocol: tcp
          httpSupport: true
      envVariables:
${renderedEnvironment}
      healthCheck:
        httpGet:
          port: ${port}
          path: '${readiness}'
      start: sh -c 'cd ${runtime} && PATH="$PWD/node/bin:$PATH" exec npm run serve'`;
  });

export const generateZeropsProviderDeployment = (
  source: string,
  topology: { readonly verticals: readonly ProviderVertical[] },
  toolchain: ZeropsToolchain,
) =>
  Effect.gen(function* generateProviderEffect() {
    if (topology.verticals.length === 0) {
      return yield* invalid('Topology has no vertical providers');
    }
    const ids = new Set();
    const ports = new Set();
    for (const vertical of topology.verticals) {
      if (ids.has(vertical.id)) {
        return yield* invalid(`Duplicate topology provider: ${vertical.id}`);
      }
      ids.add(vertical.id);
      const { port } = vertical;
      if (ports.has(port)) {
        return yield* invalid(`Duplicate topology provider port: ${port}`);
      }
      ports.add(port);
    }
    const priceGroupCatalog = topology.verticals.find((vertical) => vertical.id === 'price-group-catalog');
    const priceGroupCatalogBaseUrl =
      priceGroupCatalog === undefined
        ? undefined
        : `http://pricegroupcatalog:${priceGroupCatalog.port}/price-group-catalog-api`;
    const providers = yield* Effect.all(
      topology.verticals.map((vertical) => renderProvider(vertical, priceGroupCatalogBaseUrl, toolchain)),
    );
    const deployment = yield* readZeropsDeployment(source);
    const generated = yield* readZeropsDeployment(`zerops:\n${providers.join('\n')}\n`);
    for (const [id, defaults] of generated.services) {
      const current = deployment.services.get(id);
      if (current === undefined) {
        const shell = deployment.setups.items.findIndex((item) => isMap(item) && item.get('setup') === 'shellsuperapp');
        deployment.setups.items.splice(shell === -1 ? deployment.setups.items.length : shell, 0, defaults);
        deployment.services.set(id, defaults);
      } else {
        yield* updateZeropsService(current, defaults);
      }
      if (id === 'party-registry') {
        deployment.services.get(id)?.deleteIn(['run', 'envVariables', 'DATABASE_URL']);
      }
    }
    return yield* renderZeropsDeployment(deployment);
  });

/** Adds missing topology providers without changing operator-owned infrastructure or workers. */
export const generateZeropsProviderImports = (
  source: string,
  topology: { readonly verticals: readonly ProviderVertical[] },
) =>
  Effect.gen(function* generateProviderImports() {
    const start = source.indexOf(importsBegin);
    const stop = source.indexOf(importsEnd);
    if (
      (start !== -1 || stop !== -1) &&
      (start === -1 ||
        stop < start ||
        source.includes(importsBegin, start + 1) ||
        source.includes(importsEnd, stop + 1))
    ) {
      return yield* invalid('Invalid generated provider import markers');
    }
    const retained = start === -1 ? source : `${source.slice(0, start)}${source.slice(stop + importsEnd.length)}`;
    const importSchema = Schema.Struct({
      services: Schema.Array(
        Schema.Struct({
          enableSubdomainAccess: Schema.optionalKey(Schema.Boolean),
          hostname: Schema.String,
          type: Schema.String,
        }),
      ),
    });
    const imported = yield* Effect.try({
      catch: () => invalid('Invalid Zerops service import YAML'),
      try: () => Schema.decodeUnknownResult(importSchema)(parse(retained)),
    }).pipe(
      Effect.flatMap(Effect.fromResult),
      Effect.mapError(() => invalid('Invalid Zerops service import YAML')),
    );
    const services = new Map(imported.services.map((service) => [service.hostname, service]));
    if (services.size !== imported.services.length) {
      return yield* invalid('Duplicate Zerops service import hostname');
    }
    const hostnames = new Set<string>();
    const missing: string[] = [];
    for (const { id } of topology.verticals) {
      const hostname = id.replaceAll('-', '');
      if (
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id) ||
        !/^[a-z0-9]{1,25}$/u.test(hostname) ||
        hostnames.has(hostname)
      ) {
        return yield* invalid(`Invalid or duplicate topology provider hostname: ${id}`);
      }
      hostnames.add(hostname);
      const current = services.get(hostname);
      if (current === undefined) {
        missing.push(`  - hostname: ${hostname}\n    type: ${providerRuntimeBase}\n    enableSubdomainAccess: true`);
      } else if (current.type !== providerRuntimeBase || current.enableSubdomainAccess !== true) {
        return yield* invalid(`Zerops provider import drift: ${id}`);
      }
    }
    if (missing.length === 0 && start === -1) {
      return source;
    }
    const generated = `${importsBegin}\n${missing.join('\n')}\n${importsEnd}`;
    return start === -1
      ? `${source.trimEnd()}\n${generated}\n`
      : `${source.slice(0, start)}${generated}${source.slice(stop + importsEnd.length)}`;
  });

const migrationsBegin = '    // <generated-vertical-provider-migrations>';
const migrationsEnd = '    // </generated-vertical-provider-migrations>';
const migrationAnchor = "    yield* runAppScript('scripts/postgres/bootstrap-runtime-role.mts');";

/** Retains existing ordered migrations and adds new topology owners before the final grant refresh. */
export const generateZeropsProviderMigrations = (source: string, ownerPaths: readonly string[]) =>
  Effect.gen(function* generateProviderMigrations() {
    if (
      new Set(ownerPaths).size !== ownerPaths.length ||
      ownerPaths.some((owner) => !/^verticals\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(owner))
    ) {
      return yield* invalid('Invalid or duplicate topology migration owner');
    }
    const start = source.indexOf(migrationsBegin);
    const stop = source.indexOf(migrationsEnd);
    if ((start === -1) !== (stop === -1) || (start !== -1 && stop < start)) {
      return yield* invalid('Invalid generated provider migration markers');
    }
    const retained = start === -1 ? source : source.slice(0, start) + source.slice(stop + migrationsEnd.length + 1);
    const existing = new Set(
      [...retained.matchAll(/migrate\('(?<owner>[^']+)', 'drizzle\.config\.ts'\)/gu)].map(
        (match) => match.groups?.owner,
      ),
    );
    if (/^\s*yield\* migrateConvergentOwner\('party'\);$/mu.test(retained)) {
      existing.add('verticals/party-registry');
    }
    const missing = ownerPaths.filter((owner) => !existing.has(owner));
    if (missing.length === 0 && start === -1) {
      return source;
    }
    const anchor = retained.lastIndexOf(migrationAnchor);
    if (anchor === -1) {
      return yield* invalid('Migrator final grant refresh is missing');
    }
    const calls = missing
      .map((owner) =>
        owner === 'verticals/party-registry'
          ? "    yield* migrateConvergentOwner('party');"
          : `    yield* migrate('${owner}', 'drizzle.config.ts');`,
      )
      .join('\n');
    const generated = `${migrationsBegin}\n${calls}\n${migrationsEnd}\n`;
    return retained.slice(0, anchor) + generated + retained.slice(anchor);
  });

/** Ships root database enrollment sources and every topology migration owner in the migrator artifact. */
export const generateZeropsMigratorInventory = (source: string, ownerPaths: readonly string[]) =>
  Effect.gen(function* generateMigratorInventory() {
    if (
      new Set(ownerPaths).size !== ownerPaths.length ||
      ownerPaths.some((owner) => !/^verticals\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(owner))
    ) {
      return yield* invalid('Invalid or duplicate topology migration owner');
    }
    const deployment = yield* readZeropsDeployment(source).pipe(
      Effect.mapError(() => invalid('Missing migrator deployFiles inventory')),
    );
    const files = deployment.services.get('migrator')?.getIn(['build', 'deployFiles'], true);
    if (!isSeq(files) || files.items.some((item) => !isScalar(item) || !Schema.is(Schema.String)(item.value))) {
      return yield* invalid('Missing migrator deployFiles inventory');
    }
    const present = new Set<string>();
    files.items = files.items.filter((item) => {
      if (!isScalar(item) || !Schema.is(Schema.String)(item.value) || present.has(item.value)) {
        return false;
      }
      present.add(item.value);
      return true;
    });
    for (const artifact of ['app/database', ...ownerPaths.map((owner) => `app/${owner}`)]) {
      if (!present.has(artifact)) {
        const node = deployment.document.createNode(artifact);
        node.type = 'QUOTE_SINGLE';
        files.add(node);
        present.add(artifact);
      }
    }
    return yield* renderZeropsDeployment(deployment);
  });

const version = /^[0-9]+\.[0-9]+\.[0-9]+$/u;
const PackageManifestSchema = Schema.fromJsonString(Schema.Struct({ packageManager: Schema.String }));

/** Reads the Node pin from `.mise.toml` and the pnpm pin from `package.json#packageManager`. */
export const readZeropsToolchain = (miseToml: string, packageJson: string) =>
  Effect.gen(function* readToolchain() {
    const node = /^node = "(?<node>[^"]+)"$/mu.exec(miseToml)?.groups?.node;
    if (node === undefined || !version.test(node)) {
      return yield* invalid('.mise.toml must pin node = "<major>.<minor>.<patch>" under [tools]');
    }
    const { packageManager } = yield* Schema.decodeUnknownEffect(PackageManifestSchema)(packageJson).pipe(
      Effect.mapError(() => invalid('package.json must declare packageManager')),
    );
    const pnpm = /^pnpm@(?<pnpm>[^+]+)/u.exec(packageManager)?.groups?.pnpm;
    if (pnpm === undefined || !version.test(pnpm)) {
      return yield* invalid('package.json#packageManager must pin pnpm@<major>.<minor>.<patch>');
    }
    return { node, pnpm };
  });

const runtime = ManagedRuntime.make(NodeServices.layer);
const runCommand = ({ write }: { readonly write: boolean }) =>
  Effect.gen(function* runProviderGenerator() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve();
    const sourcePath = path.join(root, 'zerops.yaml');
    const source = yield* fs.readFileString(sourcePath);
    const topology = yield* readZeropsProviderTopology(root);
    const toolchain = yield* readZeropsToolchain(
      yield* fs.readFileString(path.join(root, '.mise.toml')),
      yield* fs.readFileString(path.join(root, 'package.json')),
    );
    const generatedProviders = yield* generateZeropsProviderDeployment(source, topology, toolchain);
    const importPath = path.join(root, 'zerops-import.yaml');
    const importSource = yield* fs.readFileString(importPath);
    const generatedImports = yield* generateZeropsProviderImports(importSource, topology);
    const migratorPath = path.join(root, 'scripts/run-zerops-migrator.mjs');
    const migratorSource = yield* fs.readFileString(migratorPath);
    const migrationOwners = yield* Effect.all(
      topology.verticals.map((vertical) =>
        fs
          .exists(path.join(root, vertical.path, 'drizzle.config.ts'))
          .pipe(Effect.map((exists) => (exists ? [vertical.path] : []))),
      ),
      { concurrency: 4 },
    );
    const generated = yield* generateZeropsMigratorInventory(generatedProviders, migrationOwners.flat());
    const generatedMigrations = yield* generateZeropsProviderMigrations(migratorSource, migrationOwners.flat());
    if (write) {
      yield* fs.writeFileString(sourcePath, generated);
      yield* fs.writeFileString(importPath, generatedImports);
      yield* fs.writeFileString(migratorPath, generatedMigrations);
    } else if (generated !== source || generatedImports !== importSource || generatedMigrations !== migratorSource) {
      yield* invalid('Zerops provider deployment drift: run pnpm zerops:providers --write');
    }
  });
const command = Command.make(
  'generate-zerops-provider-deployment',
  { write: Flag.Boolean('write').pipe(Flag.withDefault(false)) },
  runCommand,
);
if (import.meta.main) {
  void runtime.runPromise(Command.run(command, { version: '1.0.0' }));
}
