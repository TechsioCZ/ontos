import { isScriptFile, isTestFile, matchesGlobs, scopePath } from './paths.ts';

interface SourceRuleScope {
  readonly includePaths: readonly string[];
  readonly ignore: readonly string[];
  readonly includeScripts: boolean;
  readonly includeTests: boolean;
}

/** Shared dependency/factory audit scope; preserve legacy fixture normalization and gate order. */
export function isSourceRuleInScope(
  filename: string,
  options: SourceRuleScope
): boolean {
  const path = scopePath(filename);
  if (!matchesGlobs(path, options.includePaths)) return false;
  if (matchesGlobs(path, options.ignore)) return false;
  if (!options.includeScripts && isScriptFile(path)) return false;
  return options.includeTests || !isTestFile(path);
}
