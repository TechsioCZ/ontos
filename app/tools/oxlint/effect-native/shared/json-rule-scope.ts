import { booleanOption, stringList } from './options.ts';
import { isTestFile, matchesAny, workspacePath } from './paths.ts';

/** Both native JSON rules share option semantics but retain their own default include paths. */
export function inJsonRuleScope(filename: string, raw: unknown, defaultIncludePaths: readonly string[]): boolean {
  const given = (raw ?? {}) as Partial<{
    includePaths: unknown;
    allowPaths: unknown;
    ignoreTestFiles: unknown;
  }>;
  const configuredPaths = stringList(given.includePaths, defaultIncludePaths);
  const includePaths = configuredPaths.length > 0 ? configuredPaths : defaultIncludePaths;
  const path = workspacePath(filename);
  if (!matchesAny(path, includePaths)) return false;
  if (matchesAny(path, stringList(given.allowPaths, []))) return false;
  return !booleanOption(given.ignoreTestFiles, true) || !isTestFile(path);
}
