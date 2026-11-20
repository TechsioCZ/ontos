import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit } from 'effect';
import { expect, it } from 'effect-rstest';

const { sourceOnlyExportAliases } = await import(
  /* webpackIgnore: true */
  '../generate-ontos-module-contract.mts'
);

const SPECIFIER = '@app/owner/ui/widget';
const WIDGET = './src/widget.tsx';
const DEPENDS_ON_OWNER = { '@app/owner': 'workspace:*' };

/**
 * A vertical that depends on `@app/owner` (linked as pnpm links it) and an owner whose manifest exports `exports`.
 * The owner bundle of the generated contract inlines a source-only export from the target the owner's own manifest
 * names, as the vertical resolves it, so the generator never names a file of another vertical.
 */
const workspace = (exports: Readonly<Record<string, string>>, dependencies: Readonly<Record<string, string>>) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'ontos-source-only-export-')));
  const owner = path.join(root, 'verticals/owner');
  const vertical = path.join(root, 'verticals/importer');
  for (const file of [WIDGET, './src/moved.tsx']) {
    mkdirSync(path.dirname(path.join(owner, file)), { recursive: true });
    writeFileSync(path.join(owner, file), 'export const Widget = () => null;\n');
  }
  writeFileSync(path.join(owner, 'package.json'), JSON.stringify({ exports, name: '@app/owner' }));
  mkdirSync(path.join(vertical, 'node_modules/@app'), { recursive: true });
  symlinkSync('../../../owner', path.join(vertical, 'node_modules/@app/owner'));
  writeFileSync(path.join(vertical, 'package.json'), JSON.stringify({ dependencies, name: '@app/importer' }));
  return { owner, root, vertical };
};
const aliases = (exports: Readonly<Record<string, string>>, dependencies: Readonly<Record<string, string>>) =>
  Effect.gen(function* resolveAliases() {
    const fixture = workspace(exports, dependencies);
    const exit = yield* Effect.exit(sourceOnlyExportAliases(fixture.vertical, [SPECIFIER]));
    rmSync(fixture.root, { force: true, recursive: true });
    return { exit, owner: fixture.owner };
  }).pipe(Effect.provide(NodeServices.layer));

it.effect('takes a source-only alias from the export of a package the vertical depends on, and fails without it', () =>
  Effect.gen(function* exportAliases() {
    // The export the owner declares, resolved to its real file.
    const declared = yield* aliases({ './ui/widget': WIDGET }, DEPENDS_ON_OWNER);
    expect(declared.exit).toEqual(
      Exit.succeed([`--alias:${SPECIFIER}=${path.join(declared.owner, 'src/widget.tsx')}`]),
    );
    // An export that moves is followed: nothing here names the file.
    const moved = yield* aliases({ './ui/widget': './src/moved.tsx' }, DEPENDS_ON_OWNER);
    expect(moved.exit).toEqual(Exit.succeed([`--alias:${SPECIFIER}=${path.join(moved.owner, 'src/moved.tsx')}`]));
    // A package the vertical depends on that no longer exports the component fails the build, never falls back.
    const missing = yield* aliases({ './ui/other': WIDGET }, DEPENDS_ON_OWNER);
    expect(Exit.isFailure(missing.exit)).toBe(true);
    expect(String(missing.exit)).toContain(`${SPECIFIER} is not an export of the package`);
    // A vertical without the runtime dependency gets no alias and reads nothing of the owner.
    // A package name that only starts with the owner's is another package.
    expect((yield* aliases({ './ui/widget': WIDGET }, {})).exit).toEqual(Exit.succeed([]));
    expect((yield* aliases({ './ui/widget': WIDGET }, { '@app/ownership': 'workspace:*' })).exit).toEqual(
      Exit.succeed([]),
    );
  }),
);
