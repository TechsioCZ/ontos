import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, ManagedRuntime, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { parse } from 'yaml';

import { readDevelopmentPorts } from './topology-development-ports.mjs';

const begin = '  # <generated-vertical-provider-deployments>';
const end = '  # </generated-vertical-provider-deployments>';
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

interface ProviderVertical {
  readonly id: string;
  readonly package: string;
  readonly path: string;
  readonly port: number;
}

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
    const dependencyEnvironment =
      id === 'commerce-customer-context' && priceGroupCatalogBaseUrl !== undefined
        ? `\n        ONTOS_PRICE_GROUP_CATALOG_BASE_URL: '${priceGroupCatalogBaseUrl}'`
        : '';
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
        DATABASE_URL: postgresql://ontos_runtime:\${db18_password}@\${db18_hostname}:\${db18_port}/\${db18_dbName}
        NODE_ENV: production${dependencyEnvironment}
        PORT: '${port}'
        SPICEDB_CA_CERT: \${spicedb_SPICEDB_GRPC_TLS_CERT}
        SPICEDB_ENDPOINT: 'spicedb:50051'
        SPICEDB_PRESHARED_KEY: \${spicedb_SPICEDB_GRPC_PRESHARED_KEY}
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage
        ULTRAMODERN_ZEROPS_SERVICE: ${id}
        ${portKey}: '${port}'
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
    const rendered = `${begin}\n${providers.join('\n\n')}\n${end}`;
    const start = source.indexOf(begin);
    const stop = source.indexOf(end);
    if (start !== -1 || stop !== -1) {
      if (start === -1 || stop < start || source.includes(begin, start + 1) || source.includes(end, stop + 1)) {
        return yield* invalid('Invalid generated provider markers');
      }
      return `${source.slice(0, start)}${rendered}${source.slice(stop + end.length)}`;
    }
    const first = source.indexOf(`  - setup: '${topology.verticals[0]?.id}'\n`);
    const shell = source.indexOf("  - setup: 'shellsuperapp'\n");
    if (first === -1 || shell <= first) {
      return yield* invalid('Missing legacy provider section or Shell boundary');
    }
    return `${source.slice(0, first)}${rendered}\n\n${source.slice(shell)}`;
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
    const missing = ownerPaths.filter((owner) => !existing.has(owner));
    if (missing.length === 0 && start === -1) {
      return source;
    }
    const anchor = retained.lastIndexOf(migrationAnchor);
    if (anchor === -1) {
      return yield* invalid('Migrator final grant refresh is missing');
    }
    const calls = missing.map((owner) => `    yield* migrate('${owner}', 'drizzle.config.ts');`).join('\n');
    const generated = `${migrationsBegin}\n${calls}\n${migrationsEnd}\n`;
    return retained.slice(0, anchor) + generated + retained.slice(anchor);
  });

/** Ships every topology migration owner in the assembled migrator artifact. */
export const generateZeropsMigratorInventory = (source: string, ownerPaths: readonly string[]) =>
  Effect.gen(function* generateMigratorInventory() {
    if (
      new Set(ownerPaths).size !== ownerPaths.length ||
      ownerPaths.some((owner) => !/^verticals\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(owner))
    ) {
      return yield* invalid('Invalid or duplicate topology migration owner');
    }
    const start = source.indexOf("  - setup: 'migrator'\n");
    const stop = source.indexOf('    deploy:\n', start);
    const files = source.indexOf('      deployFiles:\n', start);
    if (start === -1 || files < start || stop < files) {
      return yield* invalid('Missing migrator deployFiles inventory');
    }
    const inventory = new Set(source.slice(files, stop).split('\n'));
    const missing = ownerPaths.filter((owner) => !inventory.has(`        - 'app/${owner}'`));
    const added = missing.map((owner) => `        - 'app/${owner}'\n`).join('');
    return source.slice(0, stop) + added + source.slice(stop);
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
