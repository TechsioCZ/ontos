import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

const workspace = path.resolve(import.meta.dirname, '../..');

/**
 * What one Node process sees when host code and owner code load the hosted credential store FROM SOURCE: the host by
 * its workspace path, an owner through its own `@app/core-runtime` dependency, by `import` and by `require`. It claims
 * through the host's copy and reads through each owner's reader, so unbundled code shares one module-private store,
 * without any global handle, and no package export hands an owner the store, the claim or a receiver.
 *
 * It says nothing about BUILT owners: each built API bundle inlines its own copy (the host claims each one through the
 * unit's entry). `scripts/tests/hosted-credential-claim.test.mts` and the packaged tests cover built artefacts.
 */
const PROBE = `
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Effect, Option, Redacted } from 'effect';
const workspace = process.argv[1];
const host = await import(pathToFileURL(path.join(workspace, 'packages/core-runtime/src/auth/hosted-module-credential-store.ts')).href);
const owner = createRequire(path.join(workspace, 'verticals/pricing/package.json'));
const READER = '@app/core-runtime/auth/owner-module-credential';
const imported = await import(pathToFileURL(owner.resolve(READER)).href);
const required = owner(READER);
const exported = owner('@app/core-runtime/auth/hosted-module-credentials');
const unexported = (specifier) => {
  try {
    owner.resolve(specifier);
    return false;
  } catch (error) {
    return error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED';
  }
};
const receiver = await Effect.runPromise(host.claimHostedModuleCredentials(['pricing']));
await Effect.runPromise(receiver.accept({ credentials: { pricing: Redacted.make('pricing-module-key-0000') }, schemaVersion: 1 }));
const read = (reader) => Effect.runPromise(reader.ownModuleCredential('pricing')).then((key) =>
  Option.isSome(key) ? Redacted.value(key.value) : null,
);
console.log(JSON.stringify({
  globalHandle: Object.getOwnPropertySymbols(globalThis).some((symbol) => String(symbol).includes('module-credentials')),
  imported: await read(imported),
  publicSurface: Object.keys(exported).filter((name) => name !== 'default' && name !== '__esModule').sort(),
  required: await read(required),
  storeExported: !unexported('@app/core-runtime/src/auth/hosted-module-credential-store.ts') ||
    !unexported('@app/core-runtime/auth/hosted-module-credential-store'),
}));
`;

it.live(
  'from source, host and owner code share one module-private credential store, reachable by no package export',
  () =>
    Effect.scoped(
      Effect.gen(function* oneStorePerProcess() {
        const handle = yield* ChildProcess.make(process.execPath, ['--input-type=module', '--eval', PROBE, workspace], {
          cwd: workspace,
          extendEnv: true,
          stderr: 'inherit',
          stdin: 'ignore',
          stdout: 'pipe',
        });
        const [output, code] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: 2 },
        );
        expect(code).toBe(0);
        expect(JSON.parse(output.trim())).toEqual({
          globalHandle: false,
          imported: 'pricing-module-key-0000',
          // Schemas, the variable name and the sealed error only: nothing that claims, fills or reads a slot.
          publicSurface: [
            'HostedModuleCredentialsSchema',
            'HostedModuleCredentialsSealedError',
            'ModuleAppIdSchema',
            'WorkloadCredentialsSchema',
            'workloadEntryAppId',
          ],
          required: 'pricing-module-key-0000',
          storeExported: false,
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
