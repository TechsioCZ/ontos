#!/usr/bin/env node
/**
 * Fails a browser remote that ships its own copy of @techsio/ui-kit's JavaScript. The Shell provides the kit's
 * code as strict Module Federation singletons; a remote consumes it and carries none. (A remote's CSS is
 * judged by check-module-browser-css.mts: a module ships no stylesheet at all.)
 *
 *   node scripts/check-remote-ui-kit.mts <remote dist directory>...
 *
 * A remote ships a copy when its Module Federation manifest shares a kit subpath with a fallback of its own
 * or not as a versioned singleton, or when any JavaScript file it emits carries the kit's component class
 * strings. The fingerprints come from the kit the Shell installs, so the check keeps
 * no list of its own and judges a remote built anywhere the same way.
 */
import { createRequire } from 'node:module';

import { Array as EffectArray, Console, Effect, Exit, FileSystem, Option, Path, Schema } from 'effect';
import { Argument, Command } from 'effect/cli';

import { UI_KIT_PACKAGE } from '../module-federation.shared.ts';
import { loadCoreNodeServices } from './shared/core-node-services.mts';

class RemoteUiKitCopyError extends Schema.TaggedError<RemoteUiKitCopyError>()('RemoteUiKitCopyError', {
  cause: Schema.optionalKey(Schema.Unknown),
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

const AssetListSchema = Schema.Struct({ async: Schema.Array(Schema.String), sync: Schema.Array(Schema.String) });
const RemoteManifestSchema = Schema.Struct({
  shared: Schema.Array(
    Schema.Struct({
      assets: Schema.optionalKey(Schema.Struct({ css: AssetListSchema, js: AssetListSchema })),
      name: Schema.String,
      requiredVersion: Schema.optionalKey(Schema.String),
      singleton: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
type RemoteManifest = typeof RemoteManifestSchema.Type;

const CLASS_STRING = /"(?<literal>[^"\\\n]{40,})"/gu;

const filesUnder = Effect.fn('RemoteUiKit.filesUnder')(function* filesUnder(directory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const entries = yield* fileSystem.readDirectory(directory, { recursive: true });
  return entries
    .filter((entry) => !entry.split(pathService.sep).includes('node_modules'))
    .map((entry) => pathService.join(directory, entry));
});

const shellKitRoot = Effect.fn('RemoteUiKit.shellKitRoot')(function* shellKitRoot() {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const candidates = (
    createRequire(new URL('../apps/shell-super-app/package.json', import.meta.url)).resolve.paths(UI_KIT_PACKAGE) ?? []
  ).map((directory) => pathService.join(directory, UI_KIT_PACKAGE));
  const installed = yield* Effect.filter(
    candidates,
    (candidate) => fileSystem.exists(pathService.join(candidate, 'package.json')),
    { concurrency: 1 },
  );
  return yield* Option.match(EffectArray.head(installed), {
    onNone: () => Effect.fail(new RemoteUiKitCopyError({ reason: `the Shell does not install ${UI_KIT_PACKAGE}` })),
    onSome: Effect.succeed,
  });
});

/** One utility class: lowercase, so a sentence of the kit's message catalogues never passes for a class list. */
const CLASS_TOKEN = /^[a-z0-9_:/.!@[\]%#*&>~+-]+$/u;

/** Long class-list literals of the kit's components: minification keeps them verbatim in any bundle. */
const kitClassStrings = Effect.fn('RemoteUiKit.kitClassStrings')(function* kitClassStrings(root: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const scripts = (yield* filesUnder(pathService.join(root, 'dist'))).filter((file) => file.endsWith('.js'));
  const sources = yield* Effect.forEach(scripts, (file) => fileSystem.readFileString(file), { concurrency: 8 });
  return new Set(
    sources.flatMap((source) =>
      [...source.matchAll(CLASS_STRING)].flatMap(({ groups }) => {
        const literal = groups?.literal ?? '';
        const tokens = literal.trim().split(/\s+/u);
        return tokens.length >= 4 && !/[{}();=]/u.test(literal) && tokens.every((token) => CLASS_TOKEN.test(token))
          ? [literal]
          : [];
      }),
    ),
  );
});

const manifestFindings = (manifest: RemoteManifest): string[] =>
  manifest.shared
    .filter(({ name }) => name.startsWith(`${UI_KIT_PACKAGE}/`))
    .flatMap(({ assets, name, requiredVersion, singleton }) => {
      const shipped =
        assets === undefined ? [] : [...assets.js.sync, ...assets.js.async, ...assets.css.sync, ...assets.css.async];
      return [
        ...(singleton === true && requiredVersion !== undefined && requiredVersion !== ''
          ? []
          : [`${name} is not shared as a versioned singleton`]),
        ...(shipped.length === 0 ? [] : [`${name} ships its own fallback: ${shipped.join(', ')}`]),
      ];
    });

/**
 * A bundled copy keeps each class list as one whole string literal. A module's own class string may begin with the
 * same utilities (`inline-flex … justify-center rounded-lg ${size}`), so only a quote-delimited match counts.
 */
const assetFinding = (name: string, source: string, classStrings: ReadonlySet<string>): string[] => {
  const literal = [...classStrings].find((candidate) =>
    ['"', "'", '`'].some((quote) => source.includes(`${quote}${candidate}${quote}`)),
  );
  return literal === undefined ? [] : [`${name} bundles kit JavaScript (class string "${literal}")`];
};

const remoteFindings = Effect.fn('RemoteUiKit.remoteFindings')(function* remoteFindings(
  dist: string,
  classStrings: ReadonlySet<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const manifest = yield* fileSystem
    .readFileString(pathService.join(dist, 'mf-manifest.json'))
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(RemoteManifestSchema))));
  const assets = (yield* filesUnder(dist)).filter((file) => /\.[cm]?js$/u.test(file));
  const assetResults = yield* Effect.forEach(
    assets,
    (file) =>
      fileSystem
        .readFileString(file)
        .pipe(Effect.map((source) => assetFinding(pathService.relative(dist, file), source, classStrings))),
    { concurrency: 8 },
  );
  return [...manifestFindings(manifest), ...assetResults.flat()].map((finding) => `${dist}: ${finding}`);
});

const checkRemoteUiKitCommand = Command.make(
  'check-remote-ui-kit',
  { remotes: Argument.String('remote-dist').pipe(Argument.atLeast(1)) },
  ({ remotes }) =>
    Effect.gen(function* checkRemoteUiKit() {
      const root = yield* shellKitRoot();
      const classStrings = yield* kitClassStrings(root);
      const findings = (yield* Effect.forEach(remotes, (dist) => remoteFindings(dist, classStrings), {
        concurrency: 1,
      })).flat();
      if (findings.length > 0) {
        return yield* new RemoteUiKitCopyError({
          reason: `A remote ships its own copy of ${UI_KIT_PACKAGE}. The Shell provides the kit: import kit components and share them through createSharedRuntimeConfig.\n${findings.join('\n')}`,
        });
      }
      return yield* Console.log(
        `${remotes.join(', ')}: no own copy of ${UI_KIT_PACKAGE} (${classStrings.size} class strings checked)`,
      );
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(RemoteUiKitCopyError)(cause)
          ? cause
          : new RemoteUiKitCopyError({ cause, reason: `Unable to inspect ${remotes.join(', ')}: ${String(cause)}` }),
      ),
    ),
);

const NodeServices = loadCoreNodeServices();

const exit = await Effect.runPromiseExit(
  Command.run(checkRemoteUiKitCommand, { version: '1.0.0' }).pipe(
    Effect.tapError((failure) =>
      Schema.is(RemoteUiKitCopyError)(failure) ? Console.error(failure.message) : Effect.void,
    ),
    Effect.provide(NodeServices.layer),
  ),
);
process.exitCode = Exit.isFailure(exit) ? 1 : 0;
