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

// i18next resolves `t(key, { count })` to `key_<CLDR plural category>`, and Czech has more categories than English.
const pluralCategories = (locale: string) => new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
const PLURAL_SUFFIX = /_(?:zero|one|two|few|many|other)$/u;
const messages = (keys: readonly string[]) =>
  [...new Set(keys.map((key) => key.replace(PLURAL_SUFFIX, '')))].toSorted();
const pluralForms = (keys: readonly string[]) =>
  Object.groupBy(
    keys.filter((key) => PLURAL_SUFFIX.test(key)),
    (key) => key.replace(PLURAL_SUFFIX, ''),
  );

it('has a nonempty Czech translation for every people and agent message', () => {
  expect(messages(leaves(cs.shell.agents))).toEqual(messages(leaves(en.shell.agents)));
});

it('gives every plural people and agent message exactly its locale plural forms', () => {
  for (const [locale, catalog] of [
    ['cs', cs.shell.agents],
    ['en', en.shell.agents],
  ] as const) {
    const expected = pluralCategories(locale).toSorted();
    for (const [message, forms = []] of Object.entries(pluralForms(leaves(catalog)))) {
      expect(forms.map((form) => form.slice(message.length + 1)).toSorted(), `${locale}: ${message}`).toEqual(expected);
    }
  }
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
        const plural = pluralCategories('cs').every((category) => paths.has(`${path}_${category}`));
        expect(paths.has(path) || plural, `${file}: missing Czech message ${path}`).toBe(true);
      }
      checked += 1;
    }
  }
  expect(checked).toBeGreaterThan(100);
});

it('names the current organization without technical tenant jargon in Czech', () => {
  expect(cs.shell.dashboard.tenant.accessibleLabel).toBe('Organizace');
});
