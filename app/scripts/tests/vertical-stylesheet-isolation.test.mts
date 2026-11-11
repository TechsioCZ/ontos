import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, it } from 'effect-rstest';

/**
 * A federated page's stylesheet stays in the document after the page is left, and the Shell lazy-loads pages in the
 * background. An unprefixed Tailwind utility in one vertical (`.hidden`) therefore overrides the Shell's own
 * responsive utilities (`lg:flex`) on every later page, and a ui-kit theme import re-themes the whole frame. The
 * Shell owns ui-kit's utilities and theme; verticals generate only utilities behind their own prefix.
 */
const workspace = path.resolve(import.meta.dirname, '../..');

const stylesheets = (directory: string): readonly string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' ? [] : stylesheets(full);
    }
    return entry.name.endsWith('.css') ? [full] : [];
  });

const verticalStylesheets = readdirSync(path.join(workspace, 'verticals')).flatMap((vertical) => {
  const source = path.join(workspace, 'verticals', vertical, 'src');
  try {
    return stylesheets(source);
  } catch {
    return [];
  }
});

it('vertical stylesheets generate no unprefixed utilities and load no ui-kit theme', () => {
  expect(verticalStylesheets.length).toBeGreaterThan(0);
  const leaks = verticalStylesheets.flatMap((file) => {
    const imports = readFileSync(file, 'utf-8').match(/@import\s+['"][^'"]+['"][^;]*;/gu) ?? [];
    return imports
      .filter(
        (statement) =>
          (/['"]tailwindcss['"]/u.test(statement) && !statement.includes('prefix(')) ||
          statement.includes('@techsio/ui-kit/'),
      )
      .map((statement) => `${path.relative(workspace, file)}: ${statement}`);
  });
  expect(leaks).toEqual([]);
});
