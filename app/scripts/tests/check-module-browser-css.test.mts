import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import { moduleBrowserCss } from '../check-module-browser-css.mts';

const manifest = (css: readonly string[]) =>
  JSON.stringify({
    exposes: [{ assets: { css: { async: [], sync: css }, js: { async: [], sync: [] } }, name: 'Route' }],
    shared: [{ assets: { css: { async: [], sync: [] } }, name: '@techsio/ui-kit/atoms/button' }],
  });

it.effect('a module browser build that ships a stylesheet is reported, one without CSS passes', () =>
  Effect.gen(function* seededStylesheet() {
    const fs = yield* FileSystem.FileSystem;
    const unit = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(path.join(unit, 'dist/static/js'), { recursive: true });
    yield* fs.writeFileString(path.join(unit, 'dist/static/js/index.js'), '');
    yield* fs.writeFileString(path.join(unit, 'dist/mf-manifest.json'), manifest([]));
    expect(yield* moduleBrowserCss(unit)).toEqual([]);

    yield* fs.makeDirectory(path.join(unit, 'dist/static/css/async'), { recursive: true });
    yield* fs.writeFileString(path.join(unit, 'dist/static/css/async/__federation_expose_Route.css'), '.x{}');
    yield* fs.writeFileString(
      path.join(unit, 'dist/mf-manifest.json'),
      manifest(['static/css/async/__federation_expose_Route.css']),
    );
    expect(yield* moduleBrowserCss(unit)).toEqual([
      'dist/static/css/async/__federation_expose_Route.css',
      'mf-manifest.json Route -> static/css/async/__federation_expose_Route.css',
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
