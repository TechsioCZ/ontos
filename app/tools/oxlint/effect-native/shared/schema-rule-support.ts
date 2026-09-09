import type { ESTree } from '@oxlint/plugins';

import { isTestFile, matchesGlobs, scopePath } from './paths.ts';

interface SchemaRuleScope {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly ignoreTests: boolean;
}

/** Shared source-schema rule scope, including the legacy fixture-path normalization. */
export function isSchemaRuleInScope(filename: string, options: SchemaRuleScope): boolean {
  const path = scopePath(filename);
  return (
    !matchesGlobs(path, options.ignore) &&
    matchesGlobs(path, options.include) &&
    !(options.ignoreTests && isTestFile(path))
  );
}

interface ConstructorArgumentOptions {
  readonly resolveMember: (node: ESTree.Node) => string | null;
  readonly constructors: ReadonlySet<string>;
  readonly unwrap: (node: ESTree.Node) => ESTree.Node;
}

/** Recognize direct and curried Schema constructor arguments, inspecting at most eight callees. */
export function isSchemaConstructorArgument(
  node: ESTree.Node,
  { resolveMember, constructors, unwrap }: ConstructorArgumentOptions,
): boolean {
  const parent = node.parent;
  if (parent?.type !== 'CallExpression') return false;
  if (!parent.arguments.some((argument) => argument === node)) return false;
  let callee = unwrap(parent.callee);
  for (let guard = 0; guard < 8; guard += 1) {
    const member = resolveMember(callee);
    if (member !== null) return constructors.has(member);
    if (callee.type !== 'CallExpression') return false;
    callee = unwrap(callee.callee);
  }
  return false;
}
