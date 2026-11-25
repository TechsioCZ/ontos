import path from 'node:path';

export const nativeScriptTestGlob = 'scripts/**/*.{test,spec}.{mts,mjs}';

/** The native runner, lint override and registration census accept exactly this filename family. */
export const isNativeScriptTest = (file: string): boolean =>
  path.matchesGlob(file, nativeScriptTestGlob) &&
  /^scripts\/(?:[\w.-]+\/)*[\w.-]+\.(?:test|spec)\.m[jt]s$/u.test(file) &&
  file === path.posix.normalize(file) &&
  !file.split('/').includes('..');
