import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { build } from 'esbuild';
import { Effect, Exit, FileSystem, Schema, Stream } from 'effect';
import { ChildProcess } from 'effect/process';
import { describe, expect, it } from 'effect-rstest';

import {
  API_BUNDLE,
  BUNDLE_CLAIM_EXPORT,
  exposeBundleClaim,
  exposesBundleClaim,
  inspectServedUnit,
  storeCopiesIn,
} from '../zerops/hosted-credential-claim.mts';

const workspace = path.resolve(import.meta.dirname, '../..');

const copy = (name: string) =>
  `var hostedClaim = Deferred2.makeUnsafe();\nvar ${name} = Effect258.fn("HostedModuleCredentials.claim")(function* claim2(owners) {});\n`;

describe('exposing a bundle copy claim', () => {
  it.effect('exposes exactly the one copy a bundle carries, under any name the bundler gave it, once', () =>
    Effect.gen(function* exposeOne() {
      const bundle = `${copy('claimHostedModuleCredentials3')}export {\n  index_default as default\n};\n`;
      const exposed = yield* exposeBundleClaim(bundle);
      expect(exposed.endsWith(`export { claimHostedModuleCredentials3 as ${BUNDLE_CLAIM_EXPORT} };\n`)).toBe(true);
      expect(yield* exposesBundleClaim(exposed)).toBe(true);
      expect(yield* exposeBundleClaim(exposed)).toBe(exposed);
      expect(yield* exposeBundleClaim('export { api as default };\n')).toBe('export { api as default };\n');
    }),
  );

  it.effect('refuses a bundle with two copies, a copy without a locatable claim, or a foreign exposed claim', () =>
    Effect.gen(function* refuse() {
      for (const bundle of [
        `${copy('first')}${copy('second')}`,
        'var x = "HostedModuleCredentials.claim";\n',
        `${copy('own')}\nexport { other as ${BUNDLE_CLAIM_EXPORT} };\n`,
      ]) {
        expect(Exit.isFailure(yield* Effect.exit(exposeBundleClaim(bundle)))).toBe(true);
      }
      expect(storeCopiesIn(`${copy('a')}${copy('b')}`)).toBe(2);
    }),
  );
});

/**
 * A real esbuild bundle of the module credential reader, built the way the API bundler inlines workspace sources
 * (`effect` external), and a host program that claims copies: the host's own copy never fills the bundle's, which is
 * how every built owner went without keys; the bundle's exposed claim does.
 */
const HOST = `
import { pathToFileURL } from 'node:url';
import { Effect, Option, Redacted } from 'effect';
const [workspace, bundlePath] = process.argv.slice(1);
const host = await import(pathToFileURL(workspace + '/packages/core-runtime/src/auth/hosted-module-credential-store.ts').href);
const owner = await import(pathToFileURL(bundlePath).href);
const read = () => Effect.runPromise(owner.read('crm')).then((key) => (Option.isSome(key) ? Redacted.value(key.value) : null));
const handover = { credentials: { crm: Redacted.make('crm-module-key-000000') }, schemaVersion: 1 };
const hostCopy = await Effect.runPromise(host.claimHostedModuleCredentials(['crm']));
await Effect.runPromise(hostCopy.accept(handover));
const throughHostCopy = await read();
process.env.ONTOS_GATEWAY_MODULE_API_KEY = 'environment-module-key-0';
const fromEnvironment = await read();
const bundleCopy = await Effect.runPromise(owner.${BUNDLE_CLAIM_EXPORT}(['crm']));
const beforeHandover = await read();
const answer = await Effect.runPromise(bundleCopy.accept({ ...handover, credentials: { ...handover.credentials, pricing: Redacted.make('pricing-module-key-00') } }));
const second = await Effect.runPromiseExit(owner.${BUNDLE_CLAIM_EXPORT}(['crm']));
console.log(JSON.stringify({ afterHandover: await read(), answer, beforeHandover, fromEnvironment, secondClaim: second._tag, throughHostCopy }));
`;

const READER = `${workspace}/packages/core-runtime/src/auth/owner-module-credential.ts`;

/** The two shapes the API bundler emits: an ES module, and CommonJS with the store wrapped in a lazy initialiser. */
const API_BUNDLE_OUTPUTS = [
  {
    entry: `export { ownModuleCredential as read } from '${READER}';\n`,
    file: 'index.js',
    format: 'esm',
    lazy: false,
  },
  {
    entry: `module.exports.read = (appId) => require('${READER}').ownModuleCredential(appId);\n`,
    file: 'index.cjs',
    format: 'cjs',
    lazy: true,
  },
] as const;

for (const bundling of API_BUNDLE_OUTPUTS) {
  it.live(
    `fills a built ${bundling.format} bundle copy only through its own exposed claim, never from the host copy or the environment`,
    () =>
      Effect.scoped(
        Effect.gen(function* builtBundle() {
          const fs = yield* FileSystem.FileSystem;
          // Inside the workspace, so the bundle resolves its external `effect` as a built unit does.
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: path.join(workspace, 'node_modules', '.cache'),
            prefix: 'hosted-credential-claim-',
          });
          const entry = path.join(directory, bundling.format === 'esm' ? 'entry.ts' : 'entry.cts');
          const bundlePath = path.join(directory, bundling.file);
          yield* fs.writeFileString(entry, bundling.entry);
          yield* Effect.promise(() =>
            build({
              absWorkingDir: workspace,
              bundle: true,
              entryPoints: [entry],
              external: ['effect', 'effect/*'],
              format: bundling.format,
              logLevel: 'silent',
              outfile: bundlePath,
              platform: 'node',
            }),
          );
          const bundled = yield* fs.readFileString(bundlePath);
          expect(storeCopiesIn(bundled)).toBe(1);
          expect(bundled.includes('__esm(')).toBe(bundling.lazy);
          yield* fs.writeFileString(bundlePath, yield* exposeBundleClaim(bundled));
          const handle = yield* ChildProcess.make(
            process.execPath,
            ['--input-type=module', '--eval', HOST, workspace, bundlePath],
            { cwd: workspace, extendEnv: true, stderr: 'inherit', stdin: 'ignore', stdout: 'pipe' },
          );
          const [output, code] = yield* Effect.all(
            [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
            { concurrency: 2 },
          );
          expect(code).toBe(0);
          expect(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(output.trim())).toEqual({
            afterHandover: 'crm-module-key-000000',
            answer: { accepted: ['crm'], refused: ['pricing'] },
            beforeHandover: null,
            fromEnvironment: null,
            secondClaim: 'Failure',
            throughHostCopy: null,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}

const TopologySchema = Schema.Struct({
  verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});

it.effect('serves no credential store copy a host cannot claim, in any built unit or the Outbox Worker bundle', () =>
  Effect.gen(function* builtUnits() {
    const fs = yield* FileSystem.FileSystem;
    const topology = Schema.decodeUnknownSync(Schema.fromJsonString(TopologySchema))(
      yield* fs.readFileString(path.join(workspace, 'topology/reference-topology.json')),
    );
    const units = [...topology.verticals.map(({ path: unit }) => unit), 'apps/shell-super-app'];
    const built = yield* Effect.filter(units, (unit) => fs.exists(path.join(workspace, unit, API_BUNDLE)), {
      concurrency: 1,
    });
    const problems = yield* Effect.forEach(built, (unit) => inspectServedUnit(path.join(workspace, unit)), {
      concurrency: 1,
    });
    expect(problems.flat()).toEqual([]);
    const worker = path.join(workspace, '.zerops/runtime/outbox-worker-host/worker.mjs');
    if (yield* fs.exists(worker)) {
      const source = yield* fs.readFileString(worker);
      // One bundle, one copy: the host program's own, which it claims for every caller (`holdOwnStoreCopy`).
      expect(storeCopiesIn(source)).toBe(1);
      expect(source.includes('ModuleCredentials.holdOwnCopy')).toBe(true);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
