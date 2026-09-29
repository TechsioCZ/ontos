#!/usr/bin/env node
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Console, Effect, FileSystem, Layer, Path, Redacted } from 'effect';

import { OpsShellLive } from './ops/ops-shell.mts';
import { generateGrpcMaterial } from './ops/spicedb-tls.mts';

/**
 * The development SpiceDB TLS pair in the gitignored `app/.spicedb-tls/`: one self-signed
 * certificate for `spicedb`, `localhost` and `127.0.0.1`, served on both the gRPC port and the
 * HTTP gateway. Clients pin the certificate as `SPICEDB_CA_CERT`. The key is world-readable so
 * the SpiceDB container can read the bind mount; it protects only a disposable local datastore.
 */
export const LOCAL_SPICEDB_TLS_DIRECTORY = '.spicedb-tls';
const CERTIFICATE_FILE = 'cert.pem';
const PRIVATE_KEY_FILE = 'key.pem';

/** Creates the local pair when either file is missing and returns the certificate PEM. */
export const ensureLocalSpicedbTls = Effect.gen(function* ensureLocalSpicedbTlsEffect() {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(yield* path.fromFileUrl(new URL('..', import.meta.url)), LOCAL_SPICEDB_TLS_DIRECTORY);
  const certificatePath = path.join(directory, CERTIFICATE_FILE);
  const privateKeyPath = path.join(directory, PRIVATE_KEY_FILE);
  const present = yield* Effect.all([fileSystem.exists(certificatePath), fileSystem.exists(privateKeyPath)]);
  if (present.every(Boolean)) {
    return yield* fileSystem.readFileString(certificatePath);
  }
  const material = yield* generateGrpcMaterial;
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(privateKeyPath, Redacted.value(material.privateKey), { mode: 0o644 });
  yield* fileSystem.writeFileString(certificatePath, material.certificate, { mode: 0o644 });
  yield* Console.log(`Created the local SpiceDB TLS certificate in ${directory}`);
  return material.certificate;
});

export const LocalSpicedbTlsLive = Layer.provideMerge(OpsShellLive, NodeServices.layer);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(Layer.effectDiscard(ensureLocalSpicedbTls).pipe(Layer.provide(LocalSpicedbTlsLive))).pipe(
      Effect.scoped,
    ),
  );
}
