import { readFileSync, readdirSync } from 'node:fs';
import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import cs from '../../locales/cs/shell.json';
import en from '../../locales/en/shell.json';

type Messages = string | { readonly [key: string]: Messages };
const leaves = (value: Messages, prefix = ''): string[] => {
  if (Schema.is(Schema.String)(value)) {
    expect(value.trim().length).toBeGreaterThan(0);
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix === '' ? key : `${prefix}.${key}`));
};

it('has a nonempty Czech translation for every people and agent message', () => {
  expect(leaves(cs.shell.agents).toSorted()).toEqual(leaves(en.shell.agents).toSorted());
});

it('resolves every message path used by the people and agents views, including interpolated namespaces', () => {
  const paths = new Set(leaves(cs));
  const root = new URL('../../src/routes/people/', import.meta.url);
  let checked = 0;
  for (const file of readdirSync(root).filter((name) => name.endsWith('.tsx'))) {
    const source = readFileSync(new URL(file, root), 'utf-8');
    const constants = new Map<string, string>();
    for (const match of source.matchAll(/const\s+(?<name>\w+)\s*=\s*(?<quote>['`])(?<value>[^'`\n]+)\k<quote>/gu)) {
      const { name, value } = match.groups ?? {};
      if (name !== undefined && value !== undefined) {
        constants.set(name, value);
      }
    }
    const expand = (value: string): string => {
      let result = value;
      for (let pass = 0; pass < constants.size; pass += 1) {
        result = result.replaceAll(/\$\{(?<name>\w+)\}/gu, (whole, name: string) => constants.get(name) ?? whole);
      }
      return result;
    };
    for (const match of source.matchAll(/(?<quote>['`])(?<value>[^'`\n]+)\k<quote>/gu)) {
      const { value } = match.groups ?? {};
      const path = expand(value ?? '');
      const namespace = [...constants.values()].some((constant) => expand(constant) === path) && !paths.has(path);
      if (!path.startsWith('shell.agents.') || namespace) {
        continue;
      }
      if (path.includes('${')) {
        const prefix = path.slice(0, path.indexOf('${'));
        expect(
          [...paths].some((candidate) => candidate.startsWith(prefix)),
          `${file}: ${path}`,
        ).toBe(true);
      } else {
        expect(paths.has(path), `${file}: missing Czech message ${path}`).toBe(true);
      }
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(100);
});
