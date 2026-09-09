import type { Context, ESTree, Variable } from '@oxlint/plugins';

import type { StringOptions } from './ast.ts';
import { keyName, memberName, unwrapNode } from './ast.ts';
import { lookupVariable } from './bindings.ts';
import { importedName } from './imports.ts';
import { matchesGlobs } from './paths.ts';

type Definition = Variable['defs'][number];
const SCHEMA_MODULE = /^effect\/(?:.*\/)?Schema$/u;

function schemaMember(host: string | null, member: string | null): string | null {
  if (host === '@schema') return member;
  return host === '@effect' && member === 'Schema' ? '@schema' : null;
}
function submoduleIdentity(specifier: ESTree.ImportDeclaration['specifiers'][number]): string | null {
  if (specifier.type === 'ImportNamespaceSpecifier') return '@schema';
  return specifier.type === 'ImportSpecifier' ? importedName(specifier) : null;
}
function rootIdentity(specifier: ESTree.ImportDeclaration['specifiers'][number]): string | null {
  if (specifier.type === 'ImportNamespaceSpecifier') return '@effect';
  return specifier.type === 'ImportSpecifier' && importedName(specifier) === 'Schema' ? '@schema' : null;
}
function isImportSpecifier(node: ESTree.Node): node is ESTree.ImportDeclaration['specifiers'][number] {
  return (
    node.type === 'ImportSpecifier' ||
    node.type === 'ImportNamespaceSpecifier' ||
    node.type === 'ImportDefaultSpecifier'
  );
}
function importIdentity(definition: Definition, reexports: readonly string[]): string | null {
  const specifier = definition.node;
  const declaration = definition.parent;
  if (declaration?.type !== 'ImportDeclaration' || declaration.importKind === 'type') return null;
  if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') return null;
  if (!isImportSpecifier(specifier)) return null;
  const source = declaration.source.value;
  if (SCHEMA_MODULE.test(source)) return submoduleIdentity(specifier);
  return source === 'effect' || matchesGlobs(source, reexports) ? rootIdentity(specifier) : null;
}
export function constSchemaAlias(definition: Definition): ESTree.VariableDeclarator | null {
  if (definition.type !== 'Variable' || definition.node.type !== 'VariableDeclarator' || definition.node.init === null)
    return null;
  const declarator = definition.node;
  return declarator.parent?.type === 'VariableDeclaration' && declarator.parent.kind === 'const' ? declarator : null;
}
function destructuredSchemaIdentity(
  pattern: ESTree.ObjectPattern,
  name: string,
  host: string | null,
): string | null | undefined {
  for (const property of pattern.properties) {
    if (property.type !== 'Property' || property.value.type !== 'Identifier' || property.value.name !== name) continue;
    const identity = schemaMember(host, keyName(property.key, property.computed));
    // A matching schema property returns even an unknown key, preserving the original first match.
    if (host === '@schema' || identity !== null) return identity;
  }
  return undefined;
}
function identifierIdentity(
  context: Context,
  node: ESTree.IdentifierReference | ESTree.IdentifierName | ESTree.BindingIdentifier,
  reexports: readonly string[],
  depth: number,
  syntax: StringOptions,
): string | null {
  const variable = lookupVariable(context, node);
  if (!variable) return null;
  for (const definition of variable.defs) {
    if (definition.type === 'ImportBinding') {
      const identity = importIdentity(definition, reexports);
      if (identity !== null) return identity;
    }
    const alias = constSchemaAlias(definition);
    if (!alias?.init) continue;
    if (alias.id.type === 'Identifier') return schemaIdentity(context, alias.init, reexports, depth + 1, syntax);
    if (alias.id.type !== 'ObjectPattern') continue;
    const host = schemaIdentity(context, alias.init, reexports, depth + 1, syntax);
    const identity = destructuredSchemaIdentity(alias.id, node.name, host);
    if (identity !== undefined) return identity;
  }
  return null;
}

/** Schema lexical identity: @effect root, @schema namespace, or direct member; const-only aliases,
 * glob barrels, no type-only imports, no write/typechecker inference, bounded to 16 hops.
 * Member syntax is caller-owned; defaults remain literal-only. Alias recursion retains that policy.
 */
export function schemaIdentity(
  context: Context,
  input: ESTree.Node,
  reexports: readonly string[] = [],
  depth = 0,
  syntax: StringOptions = { templates: false },
): string | null {
  if (depth > 16) return null;
  const node = unwrapNode(input, syntax.unwrap);
  if (node.type === 'MemberExpression')
    return schemaMember(schemaIdentity(context, node.object, reexports, depth + 1, syntax), memberName(node, syntax));
  return node.type === 'Identifier' ? identifierIdentity(context, node, reexports, depth, syntax) : null;
}
