import { isTestFile, matchesGlobs, scopePath } from './paths.ts';

interface RuleFilePolicy {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly ignoreTests: boolean;
}

/** Shared option shape for rules using source-rule path and test filtering. */
export const ruleFilePolicyProperties = {
  ignore: { items: { type: 'string' }, type: 'array' },
  ignoreTests: { type: 'boolean' },
  include: { items: { type: 'string' }, type: 'array' },
} as const;

/** Preserve source-rule fixture normalization and ignore-before-include precedence. */
export function acceptsRuleFile(
  filename: string,
  policy: RuleFilePolicy
): boolean {
  const path = scopePath(filename);
  if (matchesGlobs(path, policy.ignore)) return false;
  if (!matchesGlobs(path, policy.include)) return false;
  return !policy.ignoreTests || !isTestFile(path);
}
