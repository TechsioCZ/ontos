import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { existingReadPublicationGenerator, planExistingReadPublication } from '../governed-contribution/scaffold.mts';
import { runCodesmithGenerator } from '../cli.mts';
import { isModuleManifestImport } from '../shared.mts';
import { snapshotTree, write } from './fixture-files.mts';

const appRoot = path.resolve(import.meta.dirname, '../../..');
const owner = 'verticals/pricing';
const manifestFile = `${owner}/vertical.manifest.ts`;
const registrationFile = `${owner}/vertical.registration.ts`;
const originalFiles = new Map<string, string>();
const excluded = new Set(['node_modules', 'dist', '.modern', '.output', 'coverage', '.git', '.codex']);
const collect = (directory: string): void => {
  for (const entry of readdirSync(path.join(appRoot, directory), { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory() && !excluded.has(entry.name)) {
      collect(file);
    } else if (entry.isFile() && /\.(?:ts|json)$/u.test(file)) {
      originalFiles.set(file, readFileSync(path.join(appRoot, file), 'utf-8'));
    }
  }
};
collect(owner);
originalFiles.set(
  'topology/reference-topology.json',
  readFileSync(path.join(appRoot, 'topology/reference-topology.json'), 'utf-8'),
);
const names = [...originalFiles.keys()]
  .filter((file) => file.startsWith(`${owner}/src/api/`) && file.endsWith('.read.ts'))
  .map((file) => path.posix.basename(file, '.read.ts'));
const config = (name: string) => ({ authorization: 'protected', name, vertical: 'pricing' }) as const;
const withFixture = <Value, Failure, Services>(use: (root: string) => Effect.Effect<Value, Failure, Services>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => await mkdtemp(path.join(tmpdir(), 'ontos-read-publication-'))),
    use,
    (root) => Effect.promise(async () => await rm(root, { force: true, recursive: true })),
  );

for (const name of names) {
  it.effect(`plans only original owner publication for actual Pricing ${name}`, () =>
    planExistingReadPublication(appRoot, config(name)).pipe(
      Effect.tap((plan) =>
        Effect.sync(() => {
          expect(
            plan.mutations.every((mutation) =>
              [manifestFile, registrationFile].includes(path.relative(appRoot, mutation.path)),
            ),
          ).toBe(true);
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
}

it.effect(
  'canonically enrolls all mounted original Reads without touching transports, and replays without mutations',
  () =>
    withFixture((root) =>
      Effect.gen(function* replayOriginalReadPublication() {
        for (const [file, content] of originalFiles) {
          yield* write(root, file, content);
        }
        for (const name of names) {
          yield* runCodesmithGenerator(existingReadPublicationGenerator, root, config(name));
        }
        const files = yield* snapshotTree(root);
        const manifest = files[manifestFile] ?? '';
        const registration = files[registrationFile] ?? '';
        for (const name of names) {
          const camel = name.replaceAll(/-(?<letter>[a-z])/gu, (_match, letter: string) => letter.toUpperCase());
          expect(manifest).toContain(`registration: ${camel}Read`);
          expect(registration).toContain(`import { ${camel}Read } from './src/api/${name}.read.ts'`);
          const replay = yield* planExistingReadPublication(root, config(name));
          expect(replay.mutations).toEqual([]);
        }
        for (const [file, content] of originalFiles) {
          if (file !== manifestFile && file !== registrationFile) {
            expect(files[file], file).toBe(content);
          }
        }
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it('recognizes only exact generated BusinessPermission imports, not arbitrary same-named source', () => {
  const original = "import { pricingPriceReadPermission } from './shared/permissions/pricing-price-read.ts';";
  expect(isModuleManifestImport(original)).toBe(true);
  for (const invalid of [
    original.replace('./shared/permissions/', './src/private/'),
    original.replace('import {', 'import type {'),
    original.replace('pricingPriceReadPermission', 'foreignPermission'),
    original.replace('pricing-price-read.ts', 'pricing-price-write.ts'),
    original.replace('pricingPriceReadPermission', 'foreign as pricingPriceReadPermission'),
  ]) {
    expect(isModuleManifestImport(invalid)).toBe(false);
  }
});
