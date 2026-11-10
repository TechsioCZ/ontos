import { readFileSync } from 'node:fs';
import { Predicate, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

const readSource = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf-8');

const lanePath = '../../src/routes/[lang]/prodej/prilezitosti/';
const pageSource = readSource(`${lanePath}page.tsx`);
const panelSource = readSource(`${lanePath}pipeline-detail-panel.tsx`);
const contentSource = readSource(`${lanePath}pipeline-detail-content.tsx`);
const fullPageSource = readSource(`${lanePath}pipeline-detail-page.tsx`);

/** A locale file: nested objects whose leaves are the translated strings. */
interface LocaleTree {
  readonly [name: string]: string | LocaleTree;
}

const LocaleTreeSchema: Schema.Codec<LocaleTree, unknown> = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.suspend((): Schema.Codec<LocaleTree, unknown> => LocaleTreeSchema)]),
);

/** Dotted paths of every node and string leaf, e.g. `sales-pipeline`, `sales-pipeline.detail.title`. */
const localePaths = (node: LocaleTree, prefix = ''): string[] =>
  Object.entries(node).flatMap(([name, child]) => {
    const path = prefix === '' ? name : `${prefix}.${name}`;
    return Predicate.isString(child) ? [path] : [path, ...localePaths(child, path)];
  });

const decodeLocale = (path: string) =>
  new Set(localePaths(Schema.decodeUnknownSync(LocaleTreeSchema)(JSON.parse(readSource(path)))));

const localeLeaves = {
  cs: decodeLocale('../../locales/cs/sales-pipeline.json'),
  en: decodeLocale('../../locales/en/sales-pipeline.json'),
};

/** Lines of code without comments, so Czech words in explanatory comments do not count as UI text. */
const codeLines = (source: string) =>
  source.split('\n').filter((line) => {
    const trimmed = line.trim();
    return !(trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*'));
  });

const czechDiacritics = /[áčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/u;

describe('opportunity detail view on the records list', () => {
  it('reads the view mode through the shared hook and offers the shared toggle in the page header', () => {
    expect(pageSource).toContain('const [viewMode, setViewMode] = useDetailViewMode();');
    expect(pageSource).toMatch(/<DetailViewModeToggle[\s\S]*?value=\{viewMode\}/u);
    expect(pageSource).toContain("t('sales-pipeline.detailView.group')");
    expect(pageSource).toContain("t('sales-pipeline.detailView.page')");
    expect(pageSource).toContain("t('sales-pipeline.detailView.panel')");
  });

  it('defines the detailView keys in every sales-pipeline locale', () => {
    for (const leaves of Object.values(localeLeaves)) {
      for (const key of ['group', 'page', 'panel']) {
        expect(leaves.has(`sales-pipeline.detailView.${key}`)).toBe(true);
      }
    }
  });

  it('resolves every literal sales-pipeline key used by the lane in both locales', () => {
    const keyLiteral = /'(?<key>sales-pipeline\.[A-Za-z0-9_.]+)'/gu;
    const usedKeys = new Set(
      [pageSource, panelSource, contentSource, fullPageSource].flatMap((source) =>
        [...source.matchAll(keyLiteral)].flatMap((match) =>
          match.groups?.key === undefined ? [] : [match.groups.key],
        ),
      ),
    );
    expect(usedKeys.size).toBeGreaterThan(0);
    for (const key of usedKeys) {
      expect(localeLeaves.cs.has(key), `cs: ${key}`).toBe(true);
      expect(localeLeaves.en.has(key), `en: ${key}`).toBe(true);
    }
  });

  it('keeps Czech UI text out of the code of the panel, the full page, the shared content and the list', () => {
    for (const source of [panelSource, fullPageSource, contentSource, pageSource]) {
      const offending = codeLines(source).filter((line) => czechDiacritics.test(line));
      expect(offending).toEqual([]);
    }
  });

  it('keeps the quick view non-blocking in the panel mode', () => {
    expect(panelSource.match(/peek=\{peek\}/gu)?.length).toBe(2);
    const element = /<PipelineDetailPanel[\s\S]*?\/>/u.exec(pageSource)?.[0] ?? '';
    expect(element).toMatch(/\bpeek\b/u);
  });
});
