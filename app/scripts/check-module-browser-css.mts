#!/usr/bin/env node
import { Array as EffectArray, Console, Effect, FileSystem, Order, Path, Schema } from 'effect';
import { Command, Flag } from 'effect/cli';

import { runQualityCli } from './quality-cli-lifecycle.mts';

/**
 * A module's browser bundle ships no CSS of its own. The kit's stylesheet, loaded once by the Shell, styles every
 * module, so a module the Shell loads at runtime, built in this repository or outside it, looks like the rest of
 * OntOS and follows its themes. This reads what a build wrote for each module unit (`verticals/<id>/dist`): a
 * stylesheet anywhere in its browser output (`dist/static`), or a CSS asset its Module Federation manifest hands an
 * expose or a shared module, fails the check. The Shell is the kit's host and is not a module.
 */

const ManifestAssets = Schema.Struct({
  assets: Schema.optional(
    Schema.Struct({
      css: Schema.optional(
        Schema.Struct({
          async: Schema.optional(Schema.Array(Schema.String)),
          sync: Schema.optional(Schema.Array(Schema.String)),
        }),
      ),
    }),
  ),
  name: Schema.String,
});
const FederationManifest = Schema.fromJsonString(
  Schema.Struct({
    exposes: Schema.optional(Schema.Array(ManifestAssets)),
    shared: Schema.optional(Schema.Array(ManifestAssets)),
  }),
);

class ModuleShipsCss extends Schema.TaggedError<ModuleShipsCss>()('ModuleShipsCss', { message: Schema.String }) {}

const STYLESHEET = /\.(?:css|scss|sass|less|styl)$/u;

const stylesheetsBelow = (
  directory: string,
): Effect.Effect<readonly string[], never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* listStylesheets() {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(directory).pipe(Effect.orElseSucceed(() => false)))) {
      return [];
    }
    const entries = yield* fs.readDirectory(directory, { recursive: true }).pipe(Effect.orElseSucceed(() => []));
    return EffectArray.sort(
      entries.filter((entry) => STYLESHEET.test(entry)),
      Order.String,
    );
  });

/** Every CSS file and every manifest CSS asset of one module's browser build, relative to the module. */
export const moduleBrowserCss = (unit: string) =>
  Effect.gen(function* inspectUnit() {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dist = path.join(unit, 'dist');
    const files = (yield* stylesheetsBelow(path.join(dist, 'static'))).map((file) => `dist/static/${file}`);
    const manifestPath = path.join(dist, 'mf-manifest.json');
    if (!(yield* fs.exists(manifestPath))) {
      return files;
    }
    const manifest = yield* Schema.decodeUnknownEffect(FederationManifest)(yield* fs.readFileString(manifestPath));
    const assets = [...(manifest.exposes ?? []), ...(manifest.shared ?? [])].flatMap((entry) =>
      [...(entry.assets?.css?.sync ?? []), ...(entry.assets?.css?.async ?? [])].map(
        (asset) => `mf-manifest.json ${entry.name} -> ${asset}`,
      ),
    );
    return [...files, ...assets];
  });

const unitFindings = (root: string, unit: string) =>
  Effect.gen(function* findUnitCss() {
    const path = yield* Path.Path;
    const css = yield* moduleBrowserCss(path.join(root, unit));
    return css.map((entry) => `${unit}: ${entry}`);
  });

const cli = Command.make(
  'check-module-browser-css',
  { units: Flag.String('unit').pipe(Flag.atLeast(0)) },
  ({ units }) =>
    Effect.gen(function* checkModuleBrowserCss() {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* path.fromFileUrl(new URL('..', import.meta.url));
      const modules =
        units.length > 0
          ? units.filter((unit) => unit.startsWith('verticals/'))
          : EffectArray.sort(
              (yield* fs.readDirectory(path.join(root, 'verticals'))).map((name) => `verticals/${name}`),
              Order.String,
            );
      const findings = yield* Effect.forEach(modules, (unit) => unitFindings(root, unit), { concurrency: 4 });
      const shipped = findings.flat();
      if (shipped.length > 0) {
        return yield* new ModuleShipsCss({
          message: [
            'A module browser bundle ships CSS of its own. Modules ship no CSS: the kit stylesheet the Shell loads styles them.',
            ...shipped,
          ].join('\n'),
        });
      }
      return yield* Console.log(`${modules.length} module browser bundles ship no CSS of their own.`);
    }),
);

if (Schema.is(Schema.Struct({ main: Schema.Literal(true) }))(import.meta)) {
  runQualityCli(Command.run(cli, { version: '1.0.0' }));
}
