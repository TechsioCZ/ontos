import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

import { appRoot, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const applicationRequire = createRequire(path.join(appRoot, 'package.json'));
const plugin = applicationRequire.resolve('oxlint-plugin-react-doctor');
const diagnosticCode = 'react-doctor(js-set-map-lookups)';

const cases = [
  {
    expected: 0,
    name: 'imported string factory retains substring matching',
    source: `import { foldSearchText } from '@app/admin-ui';
export const matches = (entries: readonly { name: string; id: string }[], search: string) => {
  const words = foldSearchText(search.trim()).split(/\\s+/u).filter((word) => word !== '');
  return entries.flatMap((entry) => {
    const name = foldSearchText(entry.name);
    return name !== '' && words.every((word) => name.includes(word)) ? [entry.id] : [];
  });
};`,
  },
  {
    expected: 1,
    name: 'same import leaves typed array membership blocking',
    source: `import { foldSearchText } from '@app/admin-ui';
export const matches = (partyIds: readonly string[], search: string) => {
  const words = foldSearchText(search.trim()).split(/\\s+/u).filter((word) => word !== '');
  return words.every((word) => partyIds.includes(word));
};`,
  },
  {
    expected: 1,
    name: 'readonly array alias remains blocking',
    source: `type PartyIds = ReadonlyArray<string>;
export const matches = (partyIds: PartyIds, words: readonly string[]) =>
  words.every((word) => partyIds.includes(word));`,
  },
  {
    expected: 1,
    name: 'large literal array remains blocking',
    source: `const partyIds = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
export const matches = (words: readonly string[]) =>
  words.every((word) => partyIds.includes(word));`,
  },
  {
    expected: 0,
    name: 'explicit string parameter retains substring matching',
    source: `export const matches = (name: string, words: readonly string[]) =>
  words.every((word) => name.includes(word));`,
  },
  {
    expected: 0,
    name: 'unknown imported receiver is not assumed to be an array',
    source: `import { makeMatcher } from 'matcher-owner';
const matcher = makeMatcher();
export const matches = (words: readonly string[]) =>
  words.every((word) => matcher.includes(word));`,
  },
];

for (const fixture of cases) {
  it(`React Doctor lookup model: ${fixture.name}`, () => {
    withTemporaryWorkspace((directory) => {
      const config = path.join(directory, 'oxlint.json');
      writeFileSync(
        config,
        JSON.stringify({
          categories: { correctness: 'off' },
          jsPlugins: [{ name: 'react-doctor', specifier: plugin }],
          rules: { 'react-doctor/js-set-map-lookups': 'error' },
          settings: { 'react-doctor': { portedRuleMode: 'curated' } },
        }),
      );
      const source = path.join(directory, 'lookup.ts');
      writeFileSync(source, fixture.source);
      const run = runOxlint(config, [source], directory);
      expect(run.numberOfFiles).toBe(1);
      expect(run.diagnostics.filter(({ code }) => code === diagnosticCode)).toHaveLength(fixture.expected);
      expect(run.exitCode, JSON.stringify(run.diagnostics)).toBe(fixture.expected === 0 ? 0 : 1);
    });
  });
}
