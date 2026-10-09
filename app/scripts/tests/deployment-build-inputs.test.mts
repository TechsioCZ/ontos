import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { Array as EffectArray, Order, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { CONSERVATIVE_FULL_DEPLOY_PATHS } from '../plan-deployment-impact.mts';

const appRoot = path.resolve(import.meta.dirname, '../..');
const OWNED_AREAS = /^(?:apps|packages|verticals|topology)\//u;
const RELATIVE_REFERENCE = /(?:from|import|new URL\(|extends"?:?)\s*\(?\s*['"](?<reference>\.{1,2}\/[^'"]+)['"]/gu;
// The package scripts a Zerops or Cloudflare deployment runs; `dev` and test scripts never ship.
const DEPLOYED_SCRIPTS = ['build', 'cloudflare:build', 'cloudflare:deploy', 'serve'] as const;
const UnitManifestFromJson = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
);
const SCRIPT_REFERENCE = /(?<reference>(?:\.\.\/)+[\w./-]+\.(?:mts|ts|mjs|js|json))/gu;

const unitRoots = ['apps', 'verticals'].flatMap((area) =>
  readdirSync(path.join(appRoot, area), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(appRoot, area, entry.name)),
);

const relativeReferences = (file: string): readonly string[] =>
  [...readFileSync(file, 'utf-8').matchAll(RELATIVE_REFERENCE)].flatMap((match) =>
    match.groups?.reference === undefined ? [] : [path.resolve(path.dirname(file), match.groups.reference)],
  );

/** Root-level files a unit build reads, following each root file's own relative imports. */
const rootBuildInputs = (): ReadonlySet<string> => {
  const pending: string[] = [];
  for (const unitRoot of unitRoots) {
    for (const config of ['modern.config.ts', 'module-federation.config.ts', 'tsconfig.json']) {
      const file = path.join(unitRoot, config);
      if (existsSync(file)) {
        pending.push(...relativeReferences(file));
      }
    }
    const { scripts } = Schema.decodeUnknownSync(UnitManifestFromJson)(
      readFileSync(path.join(unitRoot, 'package.json'), 'utf-8'),
    );
    for (const name of DEPLOYED_SCRIPTS) {
      pending.push(
        ...[...(scripts?.[name] ?? '').matchAll(SCRIPT_REFERENCE)].flatMap((match) =>
          match.groups?.reference === undefined ? [] : [path.resolve(unitRoot, match.groups.reference)],
        ),
      );
    }
  }
  const inputs = new Set<string>();
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    const relative = path.relative(appRoot, file).split(path.sep).join('/');
    if (relative.startsWith('..') || OWNED_AREAS.test(relative) || inputs.has(relative) || !existsSync(file)) {
      continue;
    }
    inputs.add(relative);
    pending.push(...relativeReferences(file));
  }
  return inputs;
};

it('plans a full deployment for every root-level file a delivery unit build reads', () => {
  const inputs = EffectArray.sort(rootBuildInputs(), Order.String);
  expect(inputs).toContain('module-federation.shared.ts');
  expect(inputs.filter((input) => !CONSERVATIVE_FULL_DEPLOY_PATHS.has(input))).toEqual([]);
});
