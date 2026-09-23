import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, ManagedRuntime, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

const begin = '  # <generated-vertical-provider-deployments>';
const end = '  # </generated-vertical-provider-deployments>';
const TopologySchema = Schema.fromJsonString(
  Schema.Struct({
    verticals: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        moduleFederation: Schema.Struct({ manifestUrl: Schema.String }),
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
  readonly moduleFederation: { readonly manifestUrl: string };
  readonly package: string;
  readonly path: string;
}

const renderProvider = (vertical: ProviderVertical) =>
  Effect.gen(function* renderProviderEffect() {
    const { id, package: packageName, path: packageDir } = vertical;
    if (
      !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(id) ||
      packageName !== `@app/${id}` ||
      packageDir !== `verticals/${id}`
    ) {
      return yield* invalid(`Invalid topology provider identity: ${id}`);
    }
    const url = yield* Effect.try({
      catch: () => invalid(`Invalid topology provider manifest URL: ${id}`),
      try: () => new URL(vertical.moduleFederation.manifestUrl),
    });
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535 || url.pathname !== '/mf-manifest.json') {
      return yield* invalid(`Invalid topology provider manifest URL: ${id}`);
    }
    const readiness = `/${id}-api/${id}/readiness`;
    const runtime = `app/.zerops/runtime/${id}`;
    const portKey = `VERTICAL_${id.replaceAll('-', '_').toUpperCase()}_PORT`;
    const runtimeConfigurationPreflight =
      id === 'commerce-customer-context'
        ? 'test -n "$ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON" || { echo "ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON is required" >&2; exit 1; }; '
        : '';
    return `  - setup: '${id}'
    build:
      base: 'alpine@3.23'
      prepareCommands:
        - sudo apk add --no-cache curl libstdc++
        - sh /build/source/app/scripts/install-zerops-node.sh --with-pnpm 12.4.2
      buildCommands:
        - cd app && PATH="$HOME/.local/node-26.7.0/bin:$PATH" node scripts/reset-workspace-dependencies.mjs
        - cd app && PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false PATH="$HOME/.local/node-26.7.0/bin:$PATH" pnpm install --frozen-lockfile --force --config.enable-global-virtual-store=false --virtual-store-dir=node_modules/.pnpm
        - cd app && NODE_OPTIONS=--max-old-space-size=4096 PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false ULTRAMODERN_SOURCE_REVISION="$(git rev-parse HEAD)" PATH="$HOME/.local/node-26.7.0/bin:$PATH" pnpm --config.enable-global-virtual-store=false --filter '${packageName}' run build
        - cd app && PNPM_CONFIG_ENABLE_GLOBAL_VIRTUAL_STORE=false PATH="$HOME/.local/node-26.7.0/bin:$PATH" pnpm --config.enable-global-virtual-store=false run zerops:materialize --app '${id}' --package '${packageName}' --package-dir '${packageDir}'
        - cp 'app/topology/reference-topology.json' '${runtime}/topology.json'
        - cp 'app/topology/local-overlays/development.json' '${runtime}/local-overlay.json'
      deployFiles:
        - '${runtime}'
        - 'app/scripts/install-zerops-node.sh'
    deploy:
      temporaryShutdown: false
      readinessCheck:
        httpGet:
          port: ${port}
          path: '${readiness}'
        failureTimeout: 3m
        retryPeriod: 10s
    run:
      base: 'nodejs@24'
      initCommands:
        - ZEROPS_NODE_ROOT=/var/www sh app/scripts/install-zerops-node.sh
      ports:
        - port: ${port}
          protocol: tcp
          httpSupport: true
      envVariables:
        DATABASE_URL: postgresql://ontos_runtime:\${db18_password}@\${db18_hostname}:\${db18_port}/\${db18_dbName}
        NODE_ENV: production
        PORT: '${port}'
        SPICEDB_ENDPOINT: 'spicedb:50051'
        SPICEDB_INSECURE: 'true'
        SPICEDB_PRESHARED_KEY: \${spicedb_SPICEDB_GRPC_PRESHARED_KEY}
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage
        ULTRAMODERN_ZEROPS_SERVICE: ${id}
        ${portKey}: '${port}'
      healthCheck:
        httpGet:
          port: ${port}
          path: '${readiness}'
      start: sh -c '${runtimeConfigurationPreflight}cd ${runtime} && PATH="/var/www/.local/node-26.7.0/bin:$PATH" exec npm run serve'`;
  });

export const generateZeropsProviderDeployment = (
  source: string,
  topology: { readonly verticals: readonly ProviderVertical[] },
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
      const { port } = yield* Effect.try({
        catch: () => invalid(`Invalid topology provider manifest URL: ${vertical.id}`),
        try: () => new URL(vertical.moduleFederation.manifestUrl),
      });
      if (ports.has(port)) {
        return yield* invalid(`Duplicate topology provider port: ${port}`);
      }
      ports.add(port);
    }
    const providers = yield* Effect.all(topology.verticals.map((vertical) => renderProvider(vertical)));
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

const runtime = ManagedRuntime.make(NodeServices.layer);
const runCommand = ({ write }: { readonly write: boolean }) =>
  Effect.gen(function* runProviderGenerator() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.resolve();
    const sourcePath = path.join(root, 'zerops.yaml');
    const source = yield* fs.readFileString(sourcePath);
    const topologySource = yield* fs.readFileString(path.join(root, 'topology/reference-topology.json'));
    const topology = yield* Schema.decodeUnknownEffect(TopologySchema)(topologySource);
    const generated = yield* generateZeropsProviderDeployment(source, topology);
    if (write) {
      yield* fs.writeFileString(sourcePath, generated);
    } else if (generated !== source) {
      yield* invalid('Zerops provider deployment drift: run pnpm zerops:providers --write');
    }
  });
const command = Command.make(
  'generate-zerops-provider-deployment',
  { write: Flag.boolean('write').pipe(Flag.withDefault(false)) },
  runCommand,
);
if (import.meta.main) {
  void runtime.runPromise(Command.run(command, { version: '1.0.0' }));
}
