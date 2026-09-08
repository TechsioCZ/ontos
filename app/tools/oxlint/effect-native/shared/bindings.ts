import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { asNode } from './ast.ts';

type Definition = Variable['defs'][number];

export function resolveVariable(
  context: Context,
  name: string,
  from: ESTree.Node
): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(from);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}
export function lookupVariable(
  context: Context,
  identifier: ESTree.Node
): Variable | null {
  return identifier.type === 'Identifier'
    ? resolveVariable(context, identifier.name, identifier)
    : null;
}
function isValueImport(definition: Definition): boolean {
  if (definition.type !== 'ImportBinding') return false;
  return (
    definition.parent?.type === 'ImportDeclaration' &&
    definition.parent.importKind !== 'type' &&
    (definition.node.type !== 'ImportSpecifier' ||
      definition.node.importKind !== 'type')
  );
}
function isValueDefinition(definition: Definition): boolean {
  if ((definition.type as string) === 'Type') return false;
  if (definition.type !== 'ImportBinding') return true;
  return (
    asNode(definition.node)?.importKind !== 'type' &&
    asNode(definition.parent)?.importKind !== 'type'
  );
}
/** ignoreTypeOnly=false preserves the older all-definitions shadow check; JSON rules use true. */
export function isUnshadowedGlobal(
  context: Context,
  node: ESTree.Node,
  name: string,
  ignoreTypeOnly = false
): boolean {
  if (node.type !== 'Identifier' || node.name !== name) return false;
  if (!ignoreTypeOnly) {
    const variable = resolveVariable(context, name, node);
    return variable === null || variable.defs.length === 0;
  }
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    if (scope.set.get(name)?.defs.some(isValueDefinition)) return false;
    scope = scope.upper;
  }
  return true;
}
/** Unresolved identifiers remain true: callers must already have established a module import. */
export function resolvesToImport(
  context: Context,
  identifier: ESTree.Node,
  valueOnly = false
): boolean {
  const variable = lookupVariable(context, identifier);
  if (variable === null || variable.defs.length === 0) return true;
  return variable.defs.some(
    valueOnly
      ? isValueImport
      : (definition) => definition.type === 'ImportBinding'
  );
}

/** Declaration-based identity. A caller chooses object identity or span equality explicitly. */
export function isTrackedReference(
  context: Context,
  identifier: ESTree.Node,
  declaration: ESTree.Node,
  sameDeclaration: (
    left: ESTree.Node,
    right: ESTree.Node
  ) => boolean = Object.is
): boolean {
  if (identifier.type !== 'Identifier') return false;
  const variable = lookupVariable(context, identifier);
  if (!variable) return true;
  return variable.defs.some((definition) =>
    sameDeclaration(definition.name, declaration)
  );
}
