import type { ESTree } from '@oxlint/plugins';

import { asNode, parentOf, type Syntax } from './ast.ts';

const IMPORT_NAMES = new Set([
  'ImportSpecifier',
  'ImportDefaultSpecifier',
  'ImportNamespaceSpecifier',
  'ExportSpecifier',
]);
const PROPERTY_KEYS = new Set([
  'Property',
  'PropertyDefinition',
  'MethodDefinition',
]);
export interface ReferencePositionPolicy {
  /** Import/name-only copies return true for detached nodes; declaration walkers use false. */
  readonly detached?: boolean;
  /** Includes labels or rule-specific TS parents without imposing one rule's syntax policy on others. */
  readonly nonReferenceParents?: ReadonlySet<string>;
  readonly keyParents?: ReadonlySet<string>;
  readonly variableBindings?: boolean;
  /** Some legacy key tests use !== true rather than falsiness; the default retains falsiness. */
  readonly strictComputed?: boolean;
}
function isPropertyKey(
  node: ESTree.Node,
  parent: Syntax,
  policy: ReferencePositionPolicy
): boolean {
  if (
    !(policy.keyParents ?? PROPERTY_KEYS).has(parent.type) ||
    parent.key !== node
  )
    return false;
  return policy.strictComputed ? parent.computed !== true : !parent.computed;
}
/** Immediate-parent name/binding test only; type ancestry is a separate, explicitly configured test. */
export function isNonReferencePosition(
  node: ESTree.Node,
  policy: ReferencePositionPolicy = {}
): boolean {
  const parent = parentOf(node);
  if (!parent) return policy.detached ?? true;
  if (
    IMPORT_NAMES.has(parent.type) ||
    policy.nonReferenceParents?.has(parent.type)
  )
    return true;
  if (policy.variableBindings && parent.type === 'VariableDeclarator')
    return parent.id === node;
  if (parent.type === 'MemberExpression')
    return parent.property === node && !parent.computed;
  return isPropertyKey(node, parent, policy);
}
/** TS ancestry walk through caller-listed runtime TS kinds; stops at Program. */
export function isInTypePosition(
  node: ESTree.Node,
  expressionTypes: ReadonlySet<string>
): boolean {
  let current = parentOf(node);
  while (current && current.type !== 'Program') {
    if (current.type.startsWith('TS') && !expressionTypes.has(current.type))
      return true;
    current = parentOf(current);
  }
  return false;
}
/** Schema-codec variant: a TS ancestor is transparent only along its expression child edge. */
export function isInErasedTypePosition(node: ESTree.Node): boolean {
  let child = node;
  let current = parentOf(node);
  while (current) {
    if (current.type.startsWith('TS') && asNode(current.expression) !== child)
      return true;
    child = current;
    current = parentOf(current);
  }
  return false;
}
