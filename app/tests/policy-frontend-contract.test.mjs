import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const appRoot = path.resolve(new URL('..', import.meta.url).pathname);

const readAppFile = (relativePath) => readFile(path.join(appRoot, relativePath), 'utf-8');

test('shell and ticketing remote share the UI-kit toast singleton', async () => {
  const shellConfig = await readAppFile('apps/shell-super-app/module-federation.config.ts');
  const ticketingConfig = await readAppFile('verticals/ticketing/module-federation.config.ts');

  for (const source of [shellConfig, ticketingConfig]) {
    assert.match(source, /const uiKitVersion = dependencies\[['"]@techsio\/ui-kit['"]\]/u);
    assert.match(
      source,
      /['"]@techsio\/ui-kit['"]:\s*\{\s*requiredVersion: uiKitVersion,\s*singleton: true,/u,
    );
    assert.match(
      source,
      /['"]@techsio\/ui-kit\/molecules\/toast['"]:\s*\{\s*requiredVersion: uiKitVersion,\s*singleton: true,/u,
    );
  }
});
