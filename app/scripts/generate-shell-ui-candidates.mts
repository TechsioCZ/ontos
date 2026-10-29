#!/usr/bin/env node
// The Shell consumes this projection, never vertical implementation source. Every release checks ALL verticals,
// including topology-only units, before candidate publication (not before earlier successful artifact uploads).
import { createRequire } from 'node:module';
import path from 'node:path';

import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { __unstable__loadDesignSystem, compile, optimize, Polyfills } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';
import { Console, Effect, FileSystem, Layer, Option, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

const WORKSPACE = path.resolve(import.meta.dirname, '..');
const SHELL = 'apps/shell-super-app';
const STYLESHEET = 'src/routes/ui-kit.css';
const PROJECTION_SOURCE = "@source '../../generated/ui-candidates/*.txt';";
const VERTICAL_SOURCES = ['src/**/*', 'vertical.manifest.ts']
  .map((source) => `@source '${['..', '..', '..', '..', 'verticals', '*', source].join('/')}';`)
  .join('\n');

class CandidateProjectionError extends Schema.TaggedError<CandidateProjectionError>()('CandidateProjectionError', {
  cause: Schema.optional(Schema.Defect()),
  message: Schema.String,
}) {}

const compilerError = (cause: unknown) =>
  new CandidateProjectionError({ cause, message: 'Tailwind projection failed' });

/** The projection is valid only with the exact compiler the Shell's @rsbuild/plugin-tailwindcss loads. */
const requireBuildCompiler = Effect.fn('requireBuildCompiler')(function* requireCompiler(shellRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const resolve = (from: string, specifier: string) =>
    Effect.try({ catch: compilerError, try: () => createRequire(from).resolve(specifier) }).pipe(
      Effect.flatMap((file) => fs.realPath(file).pipe(Effect.mapError(compilerError))),
    );
  const plugin = yield* resolve(path.join(shellRoot, 'package.json'), '@rsbuild/plugin-tailwindcss');
  const loader = yield* resolve(plugin, '@tailwindcss/webpack');
  const differing: string[] = [];
  for (const specifier of ['@tailwindcss/node', '@tailwindcss/oxide']) {
    if ((yield* resolve(loader, specifier)) !== (yield* resolve(import.meta.filename, specifier))) {
      differing.push(specifier);
    }
  }
  if (differing.length > 0) {
    return yield* new CandidateProjectionError({
      message: `${differing.join(', ')} differ from what the Shell's Tailwind loader uses`,
    });
  }
  return loader;
});

/** Exactly @tailwindcss/webpack's compiler/automatic-root options for non-module production CSS. */
const renderStylesheet = Effect.fn('renderStylesheet')(function* render(css: string, shellRoot: string) {
  const from = path.join(shellRoot, STYLESHEET);
  const compiler = yield* Effect.tryPromise({
    catch: compilerError,
    try: async () =>
      await compile(css, {
        base: path.dirname(from),
        from,
        onDependency: () => {
          // The golden check has no persistent compiler cache.
        },
        polyfills: Polyfills.All,
        shouldRewriteUrls: true,
      }),
  });
  const roots = () => {
    if (compiler.root === 'none') {
      return [];
    }
    return compiler.root === null
      ? [{ base: shellRoot, negated: false, pattern: '**/*' }]
      : [{ ...compiler.root, negated: false }];
  };
  return yield* Effect.try({
    catch: compilerError,
    try: () =>
      optimize(compiler.build(new Scanner({ sources: [...roots(), ...compiler.sources] }).scan()), { minify: true })
        .code,
  });
});

const projectCandidates = Effect.fn('projectCandidates')(function* project(
  design: Awaited<ReturnType<typeof __unstable__loadDesignSystem>>,
  directory: string,
) {
  return yield* Effect.try({
    catch: compilerError,
    try: () => {
      const scanner = new Scanner({
        sources: ['src/**/*', 'vertical.manifest.ts'].map((pattern) => ({ base: directory, negated: false, pattern })),
      });
      const candidates = [...new Set(scanner.scan())].toSorted();
      const accepted = design.candidatesToCss(candidates);
      return candidates.filter((candidate, index) => candidate.startsWith('--') || accepted[index] !== null);
    },
  });
});

interface ProjectionOptions {
  readonly all: boolean;
  readonly check: boolean;
  readonly verifyCss: boolean;
  readonly vertical: Option.Option<string>;
  readonly workspace: string;
}

const reconcileFiles = Effect.fn('reconcileCandidateFiles')(function* reconcile(
  output: string,
  verticals: readonly string[],
  check: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const stale: string[] = [];
  if (yield* fs.exists(output)) {
    for (const file of yield* fs.readDirectory(output)) {
      if (!verticals.some((vertical) => file === `${vertical}.txt`)) {
        if (check) {
          stale.push(`obsolete ${file}`);
        } else {
          yield* fs.remove(path.join(output, file));
        }
      }
    }
  }
  return stale;
});

// Cover the old glob's domain, including unreleased topology units.
const listVerticals = Effect.fn('listProjectionVerticals')(function* list(workspace: string) {
  const fs = yield* FileSystem.FileSystem;
  const verticals: string[] = [];
  for (const directory of yield* fs.readDirectory(path.join(workspace, 'verticals'))) {
    if ((yield* fs.stat(path.join(workspace, 'verticals', directory))).type === 'Directory') {
      verticals.push(directory);
    }
  }
  return verticals.toSorted();
});

const generate = Effect.fn('generateShellUiCandidates')(function* generate(options: ProjectionOptions) {
  const fs = yield* FileSystem.FileSystem;
  if (options.all === Option.isSome(options.vertical)) {
    return yield* new CandidateProjectionError({ message: 'Choose --all or --vertical <directory>' });
  }
  if (options.verifyCss && (!options.all || !options.check)) {
    return yield* new CandidateProjectionError({ message: '--verify-css requires --check --all' });
  }
  const workspace = path.resolve(options.workspace);
  const shellRoot = path.join(workspace, SHELL);
  yield* requireBuildCompiler(shellRoot);
  const cssFile = path.join(shellRoot, STYLESHEET);
  const css = yield* fs.readFileString(cssFile);
  if (!css.includes(PROJECTION_SOURCE)) {
    return yield* new CandidateProjectionError({ message: `${cssFile} must read the generated candidate projection` });
  }
  const design = yield* Effect.tryPromise({
    catch: compilerError,
    try: async () =>
      await __unstable__loadDesignSystem(css.replace(PROJECTION_SOURCE, ''), { base: path.dirname(cssFile) }),
  });
  const verticals = yield* listVerticals(workspace);
  const requested = Option.match(options.vertical, { onNone: () => verticals, onSome: (vertical) => [vertical] });
  if (requested.some((vertical) => !verticals.includes(vertical))) {
    return yield* new CandidateProjectionError({ message: `Unknown vertical: ${requested.join(', ')}` });
  }
  const output = path.join(shellRoot, 'generated/ui-candidates');
  if (!options.check) {
    yield* fs.makeDirectory(output, { recursive: true });
  }
  const stale: string[] = [];
  for (const vertical of requested) {
    const projected = yield* projectCandidates(design, path.join(workspace, 'verticals', vertical));
    const contents = projected.length === 0 ? '' : `${projected.join('\n')}\n`;
    const roundTrip = yield* Effect.try({
      catch: compilerError,
      try: () => new Set(new Scanner({}).scanFiles([{ content: contents, extension: 'txt' }])),
    });
    if (projected.some((candidate) => !roundTrip.has(candidate))) {
      return yield* new CandidateProjectionError({ message: `Tailwind cannot round-trip ${vertical}'s projection` });
    }
    const file = path.join(output, `${vertical}.txt`);
    if (options.check) {
      if (!(yield* fs.exists(file)) || (yield* fs.readFileString(file)) !== contents) {
        stale.push(vertical);
      }
    } else {
      yield* fs.writeFileString(file, contents);
    }
  }
  if (options.all) {
    stale.push(...(yield* reconcileFiles(output, verticals, options.check)));
  }
  if (stale.length > 0) {
    return yield* new CandidateProjectionError({
      message: `Stale Shell UI candidates: ${stale.join(', ')}. Run pnpm shell:ui-candidates`,
    });
  }
  if (options.verifyCss) {
    const projected = yield* renderStylesheet(css, shellRoot);
    const original = yield* renderStylesheet(css.replace(PROJECTION_SOURCE, VERTICAL_SOURCES), shellRoot);
    if (projected !== original) {
      return yield* new CandidateProjectionError({
        message: 'Shell CSS differs from the original vertical source globs',
      });
    }
    yield* Console.log(`Shell CSS golden passed (${Buffer.byteLength(projected)} bytes)`);
  }
  return yield* Console.log(
    `Shell UI candidates ${options.check ? 'checked' : 'generated'} for ${requested.length} verticals`,
  );
});

const command = Command.make(
  'generate-shell-ui-candidates',
  {
    all: Flag.Boolean('all').pipe(Flag.withDefault(false)),
    check: Flag.Boolean('check').pipe(Flag.withDefault(false)),
    verifyCss: Flag.Boolean('verify-css').pipe(Flag.withDefault(false)),
    vertical: Flag.String('vertical').pipe(Flag.optional),
    workspace: Flag.String('workspace').pipe(Flag.withDefault(WORKSPACE)),
  },
  generate,
);

if (import.meta.main) {
  NodeRuntime.runMain(
    Layer.build(
      Layer.effectDiscard(Command.run({ version: '1.0.0' })(command)).pipe(Layer.provide(NodeServices.layer)),
    ).pipe(Effect.scoped),
  );
}
