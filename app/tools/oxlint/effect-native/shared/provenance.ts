import type { Context, ESTree, Variable } from '@oxlint/plugins';

import {
  asNode,
  literalText,
  parentOf,
  propertyText,
  syntax,
  type Syntax,
} from './ast.ts';
import { lookupVariable } from './bindings.ts';

const GLOBALS = new Set([
  'process',
  'console',
  'Bun',
  'globalThis',
  'global',
  'window',
  'self',
  'require',
  'Array',
  'Set',
]);
const CONTAINERS = new Set(['globalThis', 'global', 'window', 'self']);
const CONTAINER_MEMBERS = new Set(['process', 'console', 'Bun']);
const DEFAULT_MODULES = new Set(['process', 'console', 'util', 'module']);

function moduleIdentity(source: string): string {
  if (/^(?:node:)?(?:process|console|util|module)$/u.test(source))
    return source.replace(/^node:/u, '');
  if (source === 'effect/Effect') return 'Effect';
  if (source === 'effect/ManagedRuntime') return 'ManagedRuntime';
  return source;
}

/** Nested object/assignment destructuring path, excluding rest and dynamic keys. */
function destructuringPath(
  pattern: ESTree.Node,
  name: string
): string[] | null {
  if (pattern.type === 'Identifier') return pattern.name === name ? [] : null;
  if (pattern.type === 'AssignmentPattern')
    return destructuringPath(pattern.left, name);
  if (pattern.type !== 'ObjectPattern') return null;
  for (const property of pattern.properties) {
    if (property.type !== 'Property') continue;
    const key = propertyText(property);
    const tail = destructuringPath(property.value, name);
    if (key !== null && tail !== null) return [key, ...tail];
  }
  return null;
}

function importOrigin(definition: Variable['defs'][number]): string | null {
  const spec = asNode(definition.node)!;
  const declaration = asNode(definition.parent ?? spec.parent);
  if (
    !declaration ||
    declaration.importKind === 'type' ||
    spec.importKind === 'type'
  )
    return null;
  const source = literalText(declaration.source);
  if (!source) return null;
  const base = moduleIdentity(source);
  return importedOrigin(spec, base);
}
function importedOrigin(spec: Syntax, base: string): string | null {
  if (
    spec.type === 'ImportNamespaceSpecifier' ||
    spec.type === 'ImportDefaultSpecifier'
  )
    return base;
  const name = spec.imported?.name ?? spec.imported?.value;
  if (name === 'default') return base;
  return base === 'effect' ? name : `${base}.${name}`;
}

function variableOrigin(
  context: Context,
  node: Syntax,
  seen: ReadonlySet<Variable>
): string | null {
  const variable = lookupVariable(context, node);
  if (!variable || variable.defs.length === 0)
    return GLOBALS.has(node.name) ? node.name : null;
  if (seen.has(variable) || variable.defs.length !== 1) return null;
  const next = new Set(seen).add(variable);
  const definition = variable.defs[0]!;
  if (definition.type === 'ImportBinding') return importOrigin(definition);
  return aliasOrigin(context, node.name, variable, definition, next);
}
function aliasOrigin(
  context: Context,
  name: string,
  variable: Variable,
  definition: Variable['defs'][number],
  seen: ReadonlySet<Variable>
): string | null {
  if (
    definition.type !== 'Variable' ||
    definition.node.type !== 'VariableDeclarator'
  )
    return null;
  if (
    variable.references.some(
      (reference) => reference.init !== true && reference.isWrite()
    )
  )
    return null;
  const base = provenance(context, definition.node.init, seen);
  const path = destructuringPath(definition.node.id, name);
  return base !== null && path !== null ? [base, ...path].join('.') : null;
}

function memberOrigin(
  context: Context,
  node: Syntax,
  seen: ReadonlySet<Variable>
): string | null {
  const base = provenance(context, node.object, seen);
  const key = propertyText(node);
  if (base === null || key === null) return null;
  if (CONTAINERS.has(base) && CONTAINER_MEMBERS.has(key)) return key;
  if (DEFAULT_MODULES.has(base) && key === 'default') return base;
  return base === 'effect' ? key : `${base}.${key}`;
}
function moduleSource(value: unknown): string | null {
  const text = literalText(value);
  return text === null ? null : moduleIdentity(text);
}
function callOrigin(
  context: Context,
  node: Syntax,
  seen: ReadonlySet<Variable>
): string | null {
  const callee = provenance(context, node.callee, seen);
  if (callee === 'require') return moduleSource(node.arguments[0]);
  if (callee === 'module.createRequire') return 'require';
  return callee === 'ManagedRuntime.make' ? 'Runtime' : null;
}

/** Script runtime identity: imports, require/createRequire, globals, immutable aliases and destructuring.
 * Unlike Effect bindingPath, await is transparent and unwritten let aliases are accepted.
 */
export function provenance(
  context: Context,
  input: unknown,
  seen: ReadonlySet<Variable> = new Set()
): string | null {
  const node = syntax(input);
  if (!node) return null;
  switch (node.type) {
    case 'Identifier':
      return variableOrigin(context, node, seen);
    case 'MemberExpression':
      return memberOrigin(context, node, seen);
    case 'ImportExpression':
      return moduleSource(node.source);
    case 'CallExpression':
      return callOrigin(context, node, seen);
    default:
      return null;
  }
}

const KEY_PARENTS = new Set([
  'Property',
  'PropertyDefinition',
  'MethodDefinition',
  'TSPropertySignature',
  'TSMethodSignature',
]);
const LABEL_PARENTS = new Set([
  'LabeledStatement',
  'BreakStatement',
  'ContinueStatement',
]);
const TS_VALUES = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSTypeAssertion',
  'TSInstantiationExpression',
]);
function nonReferenceName(node: Syntax, parent: Syntax): boolean {
  if (parent.type.startsWith('Import') || parent.type === 'ExportSpecifier')
    return true;
  if (
    parent.type === 'MemberExpression' &&
    parent.property === node &&
    !parent.computed
  )
    return true;
  if (LABEL_PARENTS.has(parent.type)) return true;
  return nonReferenceKey(node, parent);
}
function nonReferenceKey(node: Syntax, parent: Syntax): boolean {
  return (
    KEY_PARENTS.has(parent.type) &&
    parent.key === node &&
    !parent.computed &&
    !(parent.shorthand && parent.value === node)
  );
}
function typePosition(node: Syntax, parent: Syntax): boolean {
  let child = node;
  let current: Syntax | null = parent;
  while (current) {
    if (
      current.type.startsWith('TS') &&
      !(TS_VALUES.has(current.type) && current.expression === child)
    )
      return true;
    if (
      current.type.endsWith('Statement') ||
      current.type.endsWith('Declaration') ||
      current.type.includes('Function')
    )
      break;
    child = current;
    current = parentOf(current);
  }
  return false;
}

/** Only lexical value reads; excludes property names, bindings and TS-only identifiers. */
export function valueReference(context: Context, input: unknown): boolean {
  const node = asNode(input);
  const parent = parentOf(node);
  if (
    !node ||
    !parent ||
    nonReferenceName(node, parent) ||
    typePosition(node, parent)
  )
    return false;
  const variable = lookupVariable(context, node);
  return (
    !variable ||
    variable.references.some((reference) => {
      const value = reference as typeof reference & {
        isValueReference?: () => boolean;
      };
      return (
        reference.identifier === node &&
        reference.isRead() &&
        (typeof value.isValueReference !== 'function' ||
          value.isValueReference())
      );
    })
  );
}
