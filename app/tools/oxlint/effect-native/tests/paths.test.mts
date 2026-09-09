import { expect, it } from 'effect-rstest';

import { isScriptFile, normalisePath } from '../shared/paths.ts';

const scriptPaths = [
  'scripts/verify.mts',
  'apps/shell-super-app/scripts/verify.mts',
  'verticals/contacts/scripts/verify.mts',
  'packages/core-runtime/scripts/verify.mts',
  'packages/core-runtime/scripts/postgres/verify.mts',
];

it('script classification agrees for relative, absolute, and normalized workspace paths', () => {
  for (const path of scriptPaths) {
    const variants = [
      path,
      `./${path}`,
      `/workspace/app/${path}`,
      `C:\\workspace\\app\\${path.replaceAll('/', '\\')}`,
      `\\\\server\\share\\app\\${path.replaceAll('/', '\\')}`,
    ];
    for (const filename of variants) {
      expect(isScriptFile(filename), filename).toBe(true);
      expect(isScriptFile(normalisePath(filename)), filename).toBe(true);
    }
  }
});

it('script classification requires a complete scripts directory segment', () => {
  for (const path of [
    'packages/core-runtime/src/verify.ts',
    'apps/shell-super-app/src/scripts.ts',
    'verticals/contacts/script/verify.mts',
    'packages/scripts-runtime/src/verify.ts',
    'packages/core-runtime/other-scripts/verify.mts',
    'packages/core-runtime/scripts-backup/verify.mts',
    'packages/core-runtime/scripts',
  ]) {
    for (const filename of [path, `/workspace/app/${path}`, `C:\\workspace\\app\\${path.replaceAll('/', '\\')}`]) {
      expect(isScriptFile(filename), filename).toBe(false);
      expect(isScriptFile(normalisePath(filename)), filename).toBe(false);
    }
  }
});
