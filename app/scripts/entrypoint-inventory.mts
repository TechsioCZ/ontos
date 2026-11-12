#!/usr/bin/env node
// Merge diagnostics: run check-module-entrypoint-boundaries over the whole workspace and print each file's first
// violation instead of stopping at the first file. The checker is read at run time and instrumented in a temporary
// sibling module (removed when the run ends), so the result always matches the checker in this tree.
//   pnpm exec node scripts/entrypoint-inventory.mts [--prefix verticals/<owner>/] [--json]
import { Console, Effect, FileSystem, Option, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';

import { runQualityCli } from './quality-cli-lifecycle.mts';

const PER_FILE = '        yield* validateProductionSource(state, file, source);';
const PHASES = [
  'validateCanonicalModuleRoute(state)',
  'validateRouteManifests(path, files, root, state)',
  'validateGatewayContract(state)',
] as const;
const PROGRAM_START = 'Effect.gen(function* checkModuleEntrypointBoundariesProgram() {';
const FindingsJson = Schema.fromJsonString(Schema.Array(Schema.String));

class EntrypointInventoryError extends Schema.TaggedError<EntrypointInventoryError>()('EntrypointInventoryError', {
  message: Schema.String,
}) {}

const collect = (expression: string): string => `{
          const outcome = yield* Effect.result(${expression});
          if (outcome._tag === 'Failure') {
            collected.push((outcome.failure as { message?: string }).message ?? String(outcome.failure));
          }
        }`;

/** The checker with every violation collected; undefined when its shape no longer matches this instrumentation. */
const instrument = (checker: string): string | undefined => {
  const phases = PHASES.map((phase) => `    yield* ${phase};`).join('\n');
  if (!checker.includes(PER_FILE) || !checker.includes(phases) || !checker.includes(PROGRAM_START)) {
    return undefined;
  }
  const collecting = checker
    .replace(PER_FILE, collect('validateProductionSource(state, file, source)'))
    .replace(phases, `${PHASES.map(collect).join('\n')}\n    return collected;`)
    .replace(PROGRAM_START, `${PROGRAM_START}\n    const collected: string[] = [];`);
  return `${collecting}\nexport const collectEntrypointViolations = (root: string) => checkModuleEntrypointBoundariesEffect(root);\n`;
};

const cli = Command.make(
  'entrypoint-inventory',
  {
    json: Flag.Boolean('json').pipe(Flag.withDefault(false)),
    prefix: Flag.String('prefix').pipe(Flag.optional),
  },
  ({ json, prefix }) =>
    Effect.gen(function* entrypointInventory() {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const scripts = yield* path.fromFileUrl(new URL('.', import.meta.url));
      const instrumented = instrument(
        yield* fileSystem.readFileString(path.join(scripts, 'check-module-entrypoint-boundaries.mts')),
      );
      if (instrumented === undefined) {
        return yield* new EntrypointInventoryError({
          message: 'check-module-entrypoint-boundaries.mts changed shape; update scripts/entrypoint-inventory.mts',
        });
      }
      const temporary = path.join(scripts, '.entrypoint-inventory.tmp.mts');
      const runner = path.join(scripts, '.entrypoint-inventory-runner.tmp.mts');
      const output = yield* Effect.acquireUseRelease(
        Effect.all([
          fileSystem.writeFileString(temporary, instrumented),
          fileSystem.writeFileString(
            runner,
            [
              "import { NodeServices } from '@effect/platform-node';",
              "import { Effect, Schema } from 'effect';",
              "import { collectEntrypointViolations } from './.entrypoint-inventory.tmp.mts';",
              'const findings = await Effect.runPromise(',
              '  collectEntrypointViolations(process.cwd()).pipe(Effect.provide(NodeServices.layer)),',
              ');',
              'process.stdout.write(Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)))(findings));',
            ].join('\n'),
          ),
        ]),
        () =>
          Effect.gen(function* runInstrumentedChecker() {
            const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
            return yield* spawner.string(
              ChildProcess.make(process.execPath, [runner], { cwd: path.dirname(scripts), stderr: 'inherit' }),
            );
          }),
        () =>
          Effect.all([fileSystem.remove(temporary, { force: true }), fileSystem.remove(runner, { force: true })]).pipe(
            Effect.ignore,
          ),
      );
      const findings = (yield* Schema.decodeEffect(FindingsJson)(output)).filter((finding) =>
        Option.match(prefix, { onNone: () => true, onSome: (selected) => finding.startsWith(selected) }),
      );
      return yield* Console.log(
        json
          ? yield* Schema.encodeEffect(FindingsJson)(findings)
          : [...findings, `${findings.length} files with violations`].join('\n'),
      );
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
