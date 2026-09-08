import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import {
  asNode,
  identityUnwrap,
  keyName,
  unwrapNode,
  type Syntax,
} from './ast.ts';
import { lookupVariable } from './bindings.ts';
import { matchesGlobs } from './paths.ts';

type Definition = Variable['defs'][number];
interface OriginPolicy {
  readonly barrels: readonly string[];
  readonly legacyOrigin: boolean;
}
interface OriginState {
  readonly policy: OriginPolicy;
  readonly seen: Set<unknown>;
  readonly depth: number;
}
const TYPE_DECLARATIONS = new Set([
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSTypeParameter',
]);
function valueDefinitions(variable: Variable): Definition[] {
  return variable.defs.filter(
    (definition) => !TYPE_DECLARATIONS.has(definition.node.type)
  );
}
function originVariable(
  context: Context,
  node: ESTree.Node,
  legacy: boolean
): { variable: Variable; definitions: readonly Definition[] } | null {
  if (!legacy) {
    const variable = lookupVariable(context, node);
    return variable ? { variable, definitions: variable.defs } : null;
  }
  if (node.type !== 'Identifier') return null;
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get(node.name);
    const definitions = variable ? valueDefinitions(variable) : [];
    if (variable && definitions.length > 0) return { variable, definitions };
    scope = scope.upper;
  }
  return null;
}
function moduleBase(source: string, policy: OriginPolicy): string[] | null {
  const root =
    source === 'effect' ||
    (policy.legacyOrigin
      ? matchesGlobs(source, policy.barrels)
      : policy.barrels.includes(source));
  if (!root && !source.startsWith('effect/')) return null;
  if (policy.legacyOrigin && root) return [];
  if (!source.startsWith('effect/')) return [];
  const last = source.split('/').at(-1)!;
  return policy.legacyOrigin || /^[A-Z]/u.test(last) ? [last] : [];
}
function importPath(
  definition: Definition,
  policy: OriginPolicy
): readonly string[] | null {
  const spec = definition.node;
  const parent = definition.parent;
  const declaration =
    policy.legacyOrigin && parent?.type !== 'ImportDeclaration'
      ? spec.parent
      : parent;
  if (
    declaration?.type !== 'ImportDeclaration' ||
    declaration.importKind === 'type'
  )
    return null;
  if (asNode(spec)?.importKind === 'type') return null;
  const base = moduleBase(declaration.source.value, policy);
  if (base === null) return null;
  return importedPath(spec, base, policy.legacyOrigin);
}
function importedPath(
  spec: ESTree.Node,
  base: readonly string[],
  legacy: boolean
): readonly string[] | null {
  if (spec.type === 'ImportNamespaceSpecifier') return base;
  if (spec.type === 'ImportDefaultSpecifier') return legacy ? base : null;
  if (spec.type !== 'ImportSpecifier') return null;
  return [
    ...base,
    spec.imported.type === 'Identifier'
      ? spec.imported.name
      : spec.imported.value,
  ];
}

/** Flat identifier destructuring only: defaults/nested patterns are intentionally not inferred. */
function flatBindingKey(pattern: ESTree.Node, name: string): string | null {
  if (pattern.type !== 'ObjectPattern') return null;
  for (const property of pattern.properties) {
    if (
      property.type !== 'Property' ||
      property.value.type !== 'Identifier' ||
      property.value.name !== name
    )
      continue;
    return keyName(property.key, property.computed);
  }
  return null;
}
function aliasDeclaration(
  definition: Definition,
  variable: Variable,
  legacy: boolean
): ESTree.VariableDeclarator | null {
  if (!legacy && definition.type !== 'Variable') return null;
  if (definition.node.type !== 'VariableDeclarator' || !definition.node.init)
    return null;
  const declaration = definition.node;
  const parent = legacy ? declaration.parent : definition.parent;
  if (parent?.type !== 'VariableDeclaration' || parent.kind !== 'const')
    return null;
  if (hasDisallowedWrites(variable, legacy)) return null;
  return declaration;
}
function hasDisallowedWrites(variable: Variable, legacy: boolean): boolean {
  return (
    legacy &&
    variable.references.some(
      (reference) => reference.isWrite() && !reference.init
    )
  );
}
function nextState(state: OriginState): OriginState {
  return { ...state, depth: state.depth + 1 };
}
function aliasPath(
  context: Context,
  node: Syntax,
  definition: Definition,
  variable: Variable,
  state: OriginState
): readonly string[] | null {
  const declaration = aliasDeclaration(
    definition,
    variable,
    state.policy.legacyOrigin
  );
  if (!declaration?.init) return null;
  const base = resolveOrigin(context, declaration.init, nextState(state));
  if (base === null) return null;
  if (declaration.id.type === 'Identifier') return base;
  const key = flatBindingKey(declaration.id, node.name);
  return key === null ? null : [...base, key];
}
function identifierPath(
  context: Context,
  node: Syntax,
  state: OriginState
): readonly string[] | null {
  const found = originVariable(context, node, state.policy.legacyOrigin);
  if (!found || found.definitions.length !== 1) return null;
  if (!state.policy.legacyOrigin && state.seen.has(found.variable)) return null;
  state.seen.add(found.variable);
  const definition = found.definitions[0]!;
  return definition.type === 'ImportBinding'
    ? importPath(definition, state.policy)
    : aliasPath(context, node, definition, found.variable, state);
}
function resolveOrigin(
  context: Context,
  input: ESTree.Node,
  state: OriginState
): readonly string[] | null {
  if (state.policy.legacyOrigin && state.depth > 24) return null;
  const node = state.policy.legacyOrigin
    ? unwrapNode(input)
    : identityUnwrap(input);
  if (node.type === 'MemberExpression') {
    const key = keyName(node.property, node.computed);
    const base = resolveOrigin(context, node.object, nextState(state));
    return base !== null && key !== null ? [...base, key] : null;
  }
  return node.type === 'Identifier'
    ? identifierPath(context, node as Syntax, state)
    : null;
}

/** Generator/concurrency identity: sequence-last; exact extra modules; uppercase Effect submodules;
 * namespace/named imports; const aliases. Preserves the original shared seen-set behavior.
 */
export function bindingPath(
  context: Context,
  expression: ESTree.Node,
  extraModules: readonly string[] = [],
  seen = new Set<unknown>()
): readonly string[] | null {
  return resolveOrigin(context, expression, {
    policy: { barrels: extraModules, legacyOrigin: false },
    seen,
    depth: 0,
  });
}

/** Failure-rule identity: glob barrels; default imports; value-namespace lookup; reject writes;
 * no sequence-last; bounded at 24 alias/member hops. Deliberately distinct from bindingPath.
 */
export function effectOrigin(
  context: Context,
  input: ESTree.Node,
  barrels: readonly string[],
  depth = 0
): readonly string[] | null {
  return resolveOrigin(context, input, {
    policy: { barrels, legacyOrigin: true },
    seen: new Set(),
    depth,
  });
}

/** Curried Effect.fn/gen callees peel calls, then use generator-family runtime identity. */
export function isGenCallee(
  context: Context,
  input: ESTree.Node | null,
  members: readonly string[],
  extraModules: readonly string[] = []
): boolean {
  if (input === null) return false;
  const target = identityUnwrap(input);
  if (target.type === 'CallExpression')
    return isGenCallee(context, target.callee, members, extraModules);
  const path = bindingPath(context, target, extraModules);
  return (
    path?.length === 2 &&
    path[0] === 'Effect' &&
    members.includes(path[1] ?? '')
  );
}
