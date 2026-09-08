#!/usr/bin/env node
import { NodeFileSystem, NodePath } from '@effect/platform-node';
import {
  Cause,
  Config,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
} from 'effect';

import { APP_ENV_PATH } from '../packages/core-runtime/src/environment/workspace-environment.ts';
import { localPublicClientValues, localSpiceDbValues } from './local-environment-values.mts';

const ShellIdSchema = Schema.String.pipe(Schema.brand('ShellId'));
const TopologySchema = Schema.fromJsonString(
  Schema.Struct({
    shell: Schema.Struct({
      id: ShellIdSchema,
    }),
  }),
);
const LocalOverlaySchema = Schema.fromJsonString(
  Schema.Struct({
    apis: Schema.Struct({
      'party-registry': Schema.String,
    }),
    ports: Schema.Record(Schema.String, Schema.Number),
  }),
);
const PublicClientTopologySchema = Schema.Struct({
  partyRegistryApiBaseUrl: Schema.String,
  shellId: ShellIdSchema,
  shellPort: Schema.Number,
});

const optionalTrimmedString = (name: string) => Config.option(Config.schema(Schema.Trim, name));
const LocalEnvironmentOverrides = Config.all({
  grpcPort: optionalTrimmedString('LOCAL_SPICEDB_GRPC_PORT'),
  httpPort: optionalTrimmedString('LOCAL_SPICEDB_HTTP_PORT'),
  preSharedKey: Config.option(
    Config.schema(
      Schema.RedactedFromValue(Schema.Trim, { label: 'LOCAL_SPICEDB_PRESHARED_KEY' }),
      'LOCAL_SPICEDB_PRESHARED_KEY',
    ),
  ),
});

const nonEmptyValue = (value: Option.Option<string>): string | undefined =>
  value.pipe(
    Option.filter((candidate) => candidate.length > 0),
    Option.getOrUndefined,
  );

const nonEmptyRedactedValue = (
  value: Option.Option<Redacted.Redacted>,
): Redacted.Redacted | undefined =>
  value.pipe(
    Option.filter((candidate) => Redacted.value(candidate).length > 0),
    Option.getOrUndefined,
  );

const main = Effect.gen(function* ensureLocalEnvironment() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const topologyPath = yield* path.fromFileUrl(
    new URL('../topology/reference-topology.json', import.meta.url),
  );
  const overlayPath = yield* path.fromFileUrl(
    new URL('../topology/local-overlays/development.json', import.meta.url),
  );
  const [original, topologySource, overlaySource, overrides] = yield* Effect.all([
    fileSystem.readFileString(APP_ENV_PATH, 'utf-8'),
    fileSystem.readFileString(topologyPath, 'utf-8'),
    fileSystem.readFileString(overlayPath, 'utf-8'),
    LocalEnvironmentOverrides,
  ]);
  const topology = yield* Schema.decodeUnknownEffect(TopologySchema)(topologySource);
  const overlay = yield* Schema.decodeUnknownEffect(LocalOverlaySchema)(overlaySource);
  const lines = original.replaceAll('\r\n', '\n').split('\n');
  const shellId = topology.shell.id;
  const publicClientTopology = yield* Schema.decodeUnknownEffect(PublicClientTopologySchema)({
    partyRegistryApiBaseUrl: overlay.apis['party-registry'],
    shellId,
    shellPort: overlay.ports[shellId],
  });
  const remaining = new Map(
    Object.entries({
      ...localPublicClientValues(lines, publicClientTopology),
      ...localSpiceDbValues(lines, {
        grpcPort: nonEmptyValue(overrides.grpcPort),
        httpPort: nonEmptyValue(overrides.httpPort),
        preSharedKey: nonEmptyRedactedValue(overrides.preSharedKey),
      }),
    }),
  );
  const updated = lines.map((line) => {
    const match = /^(?<key>[A-Z][A-Z0-9_]*)=/u.exec(line);
    const key = match?.groups?.key;
    if (key === undefined || !remaining.has(key)) {
      return line;
    }
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });

  while (updated.at(-1) === '') {
    updated.pop();
  }
  if (remaining.size > 0) {
    updated.push('', '# Development-only local service values.');
    for (const [key, value] of remaining) {
      updated.push(`${key}=${value}`);
    }
  }

  const temporaryPath = `${APP_ENV_PATH}.tmp-${process.pid}`;
  yield* fileSystem.writeFileString(temporaryPath, `${updated.join('\n')}\n`, { mode: 0o600 });
  yield* fileSystem.rename(temporaryPath, APP_ENV_PATH);
  console.log(`Updated the canonical local environment at ${APP_ENV_PATH}`);
});

const NodeServicesLive = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const exit = await Effect.runPromiseExit(
  main.pipe(
    Effect.tapCause((cause) => Effect.logError(Cause.pretty(cause))),
    Effect.provide(NodeServicesLive),
  ),
);
if (Exit.isFailure(exit)) {
  process.exitCode = 1;
}
