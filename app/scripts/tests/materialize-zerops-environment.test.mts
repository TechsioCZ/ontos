import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Array as Arr, Effect, Exit, FileSystem, Layer, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseDocument } from 'yaml';

import {
  joinZeropsDeployments,
  materializeZeropsEnvironment,
  materializeZeropsSetupFiles,
} from '../materialize-zerops-environment.mts';
import { OpsShellLive, runCommand } from '../ops/ops-shell.mts';

const HOST = 'outbox-worker-host';
const stage = { environment: 'stage' } as const;
const PRODUCTION_SPICEDB_ENDPOINT = 'spicedb.production.test:443';
const readSetups = (text: string) =>
  Schema.decodeUnknownSync(Schema.Struct({ zerops: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }))(
    parseDocument(text).toJS(),
  ).zerops;
const fixture = `zerops:
  - setup: before
    run:
      envVariables:
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage
  - setup: outbox-worker-host
    build:
      buildCommands:
        - echo "outbox-worker-host build"
      envVariables:
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage
        ZE_FAIL_BUILD: 'true'
    run:
      start: node worker.mjs
      envVariables:
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage
        SPICEDB_CA_CERT: \${spicedb_SPICEDB_GRPC_TLS_CERT}
        SPICEDB_ENDPOINT: spicedb:50051
        PORT: '4100'
  - setup: outbox-worker-host-extra
    run:
      envVariables:
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage
`;

for (const indent of [2, 4, 6]) {
  for (const name of [HOST, `'${HOST}'`, `"${HOST}"`]) {
    it.effect(`selects the exact setup with indentation ${indent} and scalar ${name}`, () =>
      Effect.gen(function* selectsSetup() {
        const input = parseDocument(fixture.replace(`setup: ${HOST}\n`, `setup: ${name}\n`)).toString({
          indent,
          lineWidth: 0,
        });
        const result = parseDocument(yield* materializeZeropsEnvironment(input, stage, HOST));
        expect(result.toJS()).toEqual({ zerops: [readSetups(fixture)[1]] });
      }),
    );
  }
}

it.effect('preserves the real native host build, deploy, run and environment values under 50 kB', () =>
  Effect.gen(function* selectsNativeHost() {
    const input = readFileSync(new URL('../../zerops.yaml', import.meta.url), 'utf-8');
    const source = parseDocument(input);
    const text = yield* materializeZeropsEnvironment(input, stage, HOST);
    expect(parseDocument(text).toJS()).toEqual({
      zerops: [readSetups(input).find((item) => item.setup === HOST)],
    });
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(50_000);
    const all = yield* materializeZeropsEnvironment(input, stage);
    expect(parseDocument(all).toJS()).toEqual(source.toJS());
  }),
);

for (const example of [
  { input: fixture.replace(`setup: ${HOST}\n`, 'setup: other\n'), matches: 0 },
  { input: fixture.replace('setup: before', `setup: "${HOST}"`), matches: 2 },
]) {
  it.effect(`rejects ${example.matches} exact matches instead of selecting a prefix or the first duplicate`, () =>
    Effect.gen(function* rejectsAmbiguousSetup() {
      const error = yield* Effect.flip(materializeZeropsEnvironment(example.input, stage, HOST));
      expect(error.message).toBe(`zerops.yaml needs exactly one setup "${HOST}", found ${example.matches}`);
    }),
  );
  it.effect(`the real CLI rejects ${example.matches} matches without overwriting an existing output`, () =>
    Effect.scoped(
      Effect.gen(function* rejectsCliSelection() {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'zerops-setup-rejection-' });
        const input = `${directory}/input.yaml`;
        const output = `${directory}/output.yaml`;
        yield* fs.writeFileString(input, example.input);
        yield* fs.writeFileString(output, 'preserve-existing-output');
        const outcome = yield* runCommand({
          args: [
            new URL('../materialize-zerops-environment.mts', import.meta.url).pathname,
            '--environment',
            'stage',
            '--input',
            input,
            '--setup',
            HOST,
            '--output',
            output,
          ],
          captureProviderFailure: true,
          command: 'node',
        }).pipe(Effect.exit);
        expect(Exit.isFailure(outcome)).toBe(true);
        expect(yield* fs.readFileString(output)).toBe('preserve-existing-output');
      }),
    ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
}

it.effect('rejects malformed YAML and a selected setup without its own deployment environment', () =>
  Effect.gen(function* rejectsInvalidSelectedSetup() {
    const malformed = yield* Effect.flip(materializeZeropsEnvironment('zerops: [', stage, HOST));
    expect(malformed.message).toContain('has no zerops setups');
    const input = parseDocument(fixture);
    for (const phase of ['build', 'run']) {
      input.deleteIn(['zerops', 1, phase, 'envVariables', 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT']);
    }
    const missingEnvironment = yield* Effect.flip(materializeZeropsEnvironment(input.toString(), stage, HOST));
    expect(missingEnvironment.message).toContain('no zerops.yaml setup sets ULTRAMODERN_DEPLOYMENT_ENVIRONMENT');
  }),
);

it.effect('only rewrites the selected setup for production and preserves its TLS and build values', () =>
  Effect.gen(function* materializesSelectedProduction() {
    const expected = parseDocument(fixture);
    expected.setIn(['zerops', 1, 'build', 'envVariables', 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'], 'production');
    expected.setIn(['zerops', 1, 'run', 'envVariables', 'ULTRAMODERN_DEPLOYMENT_ENVIRONMENT'], 'production');
    expected.setIn(['zerops', 1, 'run', 'envVariables', 'SPICEDB_ENDPOINT'], PRODUCTION_SPICEDB_ENDPOINT);
    const text = yield* materializeZeropsEnvironment(
      fixture,
      { environment: 'production', spiceDbEndpoint: PRODUCTION_SPICEDB_ENDPOINT },
      HOST,
    );
    expect(parseDocument(text).toJS()).toEqual({ zerops: [readSetups(expected.toString())[1]] });
  }),
);

for (const bytes of [49_999, 50_000, 50_001]) {
  it.effect(`enforces the selected file byte limit at ${bytes} bytes including multibyte values`, () =>
    Effect.gen(function* checksByteLimit() {
      const document = parseDocument(fixture);
      document.setIn(['zerops', 1, 'run', 'envVariables', 'PADDING'], 'é');
      const baseline = yield* materializeZeropsEnvironment(document.toString({ lineWidth: 0 }), stage, HOST);
      document.setIn(
        ['zerops', 1, 'run', 'envVariables', 'PADDING'],
        `é${'x'.repeat(bytes - new TextEncoder().encode(baseline).byteLength)}`,
      );
      const input = document.toString({ lineWidth: 0 });
      if (bytes < 50_000) {
        const text = yield* materializeZeropsEnvironment(input, stage, HOST);
        expect(new TextEncoder().encode(text).byteLength).toBe(bytes);
      } else {
        const error = yield* Effect.flip(materializeZeropsEnvironment(input, stage, HOST));
        expect(error.message).toContain('must be smaller than 50000 bytes');
      }
    }),
  );
}

const providers = `zerops:
  - setup: provider
    run:
      envVariables:
        ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: stage
        SPICEDB_ENDPOINT: spicedb:50051
  - setup: spicedb
    run:
      base: alpine/docker@26.1
`;
const production = { environment: 'production', spiceDbEndpoint: PRODUCTION_SPICEDB_ENDPOINT } as const;

it.effect('joins every deployment file and splits it into one pushable file per setup', () =>
  Effect.gen(function* splitsSetups() {
    const joined = yield* joinZeropsDeployments([fixture, providers]);
    expect(readSetups(joined).map(({ setup }) => setup)).toEqual([
      'before',
      HOST,
      `${HOST}-extra`,
      'provider',
      'spicedb',
    ]);
    const files = yield* materializeZeropsSetupFiles(joined, production);
    expect(files.map(({ setup }) => setup)).toEqual(readSetups(joined).map(({ setup }) => setup));
    const file = (setup: string) => parseDocument(files.find((item) => item.setup === setup)?.file ?? '');
    expect(file('provider').toJS()).toEqual({
      zerops: [
        {
          run: {
            envVariables: {
              SPICEDB_ENDPOINT: production.spiceDbEndpoint,
              ULTRAMODERN_DEPLOYMENT_ENVIRONMENT: 'production',
            },
          },
          setup: 'provider',
        },
      ],
    });
    // A setup that names no environment, such as SpiceDB, still gets its own unchanged file.
    expect(file('spicedb').toJS()).toEqual({ zerops: [readSetups(providers)[1]] });
    const unnamed = yield* Effect.flip(materializeZeropsSetupFiles(`${fixture}  - setup: ../escape\n`, production));
    expect(unnamed.message).toContain('cannot name a file');
    expect((yield* Effect.flip(joinZeropsDeployments([]))).message).toBe('no zerops.yaml to join');
    expect((yield* Effect.flip(joinZeropsDeployments([fixture, 'zerops: [']))).message).toContain(
      'has no zerops setups',
    );
  }),
);

it.effect('the real CLI writes one setup file per setup of every input', () =>
  Effect.scoped(
    Effect.gen(function* writesSetupFiles() {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'zerops-setup-files-' });
      yield* fs.writeFileString(`${directory}/zerops.yaml`, fixture);
      yield* fs.writeFileString(`${directory}/zerops-providers.yaml`, providers);
      const materialize = (output: readonly string[]) =>
        runCommand({
          args: [
            new URL('../materialize-zerops-environment.mts', import.meta.url).pathname,
            '--environment',
            'stage',
            '--input',
            `${directory}/zerops.yaml`,
            '--input',
            `${directory}/zerops-providers.yaml`,
            ...output,
          ],
          captureProviderFailure: true,
          command: 'node',
        }).pipe(Effect.exit);
      expect(Exit.isSuccess(yield* materialize(['--output-directory', `${directory}/out`]))).toBe(true);
      expect(Arr.sort(yield* fs.readDirectory(`${directory}/out`), Order.String)).toEqual([
        'before.yaml',
        `${HOST}-extra.yaml`,
        `${HOST}.yaml`,
        'provider.yaml',
        'spicedb.yaml',
      ]);
      expect(parseDocument(yield* fs.readFileString(`${directory}/out/provider.yaml`)).toJS()).toEqual({
        zerops: [readSetups(providers)[0]],
      });
      // One file holds both inputs only when it stays pushable; a selected setup still works.
      expect(Exit.isSuccess(yield* materialize(['--output', `${directory}/one.yaml`, '--setup', 'provider']))).toBe(
        true,
      );
      expect(
        Exit.isFailure(yield* materialize(['--output-directory', `${directory}/out`, '--setup', 'provider'])),
      ).toBe(true);
      expect(Exit.isFailure(yield* materialize([]))).toBe(true);
    }),
  ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
);
