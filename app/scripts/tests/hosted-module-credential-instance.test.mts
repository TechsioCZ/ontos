import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { expect, it } from 'effect-rstest';

const workspace = path.resolve(import.meta.dirname, '../..');

/**
 * What one Node process sees when the host code and an owner bundle load the hosted credential store: the host by its
 * workspace path (as serve-units and the Outbox host import it), an owner through its own `@app/core-runtime`
 * dependency, by `import` (ESM owners) and by `require` (CommonJS owners). It claims through the host's copy and reads
 * through each owner's, so it proves the slots are one module-private store, without any global handle.
 */
const PROBE = `
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigProvider, Config, Effect, Redacted } from 'effect';
const workspace = process.argv[1];
const host = await import(pathToFileURL(path.join(workspace, 'packages/core-runtime/src/auth/hosted-module-credentials.ts')).href);
const owner = createRequire(path.join(workspace, 'verticals/pricing/package.json'));
const imported = await import(pathToFileURL(owner.resolve('@app/core-runtime/auth/hosted-module-credentials')).href);
const required = owner('@app/core-runtime/auth/hosted-module-credentials');
const receiver = await Effect.runPromise(host.claimHostedModuleCredentials(['pricing']));
await Effect.runPromise(receiver.accept({ credentials: { pricing: Redacted.make('pricing-module-key-0000') }, schemaVersion: 1 }));
const read = (store) => Effect.runPromise(Config.String('ONTOS_GATEWAY_MODULE_API_KEY').parse(
  store.moduleCredentialConfigProvider(ConfigProvider.fromUnknown({}), 'pricing'),
));
console.log(JSON.stringify({
  globalHandle: Object.getOwnPropertySymbols(globalThis).some((symbol) => String(symbol).includes('module-credentials')),
  imported: await read(imported),
  required: await read(required),
  sameModule: imported.claimHostedModuleCredentials === host.claimHostedModuleCredentials &&
    required.claimHostedModuleCredentials === host.claimHostedModuleCredentials,
}));
`;

it.live('shares one module-private credential store between the host and every owner bundle of a process', () =>
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
        required: 'pricing-module-key-0000',
        sameModule: true,
      });
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
