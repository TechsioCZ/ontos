import type { Context, ESTree } from '@oxlint/plugins';

import { asNode, memberName, parentOf, skipWrappers, staticString, unwrap } from './ast.ts';
import type { Syntax } from './ast.ts';
import { lookupVariable } from './bindings.ts';

const nativeFactories = new Set(['ActionServiceFactory', 'ReadServiceFactory']);
const nativeDefinitions = new Set(['defineAction', 'defineRead']);
const nativeRuntimeModule = '@app/core-runtime';
const transparentWrappers = new Set(['ParenthesizedExpression', 'ChainExpression', 'TSNonNullExpression']);

const importedName = (context: Context, identifier: ESTree.Node, source: string, valueOnly = false): string | null => {
  const variable = lookupVariable(context, identifier);
  if (variable?.defs.length !== 1) {
    return null;
  }
  const [definition] = variable.defs;
  const declaration = asNode(definition?.parent);
  const specifier = asNode(definition?.node);
  if (definition?.type !== 'ImportBinding' || declaration?.type !== 'ImportDeclaration') {
    return null;
  }
  if (declaration.source.value !== source) {
    return null;
  }
  if (valueOnly && (declaration.importKind === 'type' || specifier?.importKind === 'type')) {
    return null;
  }
  if (specifier?.type === 'ImportNamespaceSpecifier') {
    return '*';
  }
  if (specifier?.type !== 'ImportSpecifier') {
    return null;
  }
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
};

const nativeFactoryAnnotation = (context: Context, annotation: ESTree.Node | null | undefined): boolean => {
  let node = asNode(annotation);
  if (node?.type === 'TSTypeAnnotation') {
    node = asNode(node.typeAnnotation);
  }
  if (node?.type !== 'TSTypeReference') {
    return false;
  }
  const name = asNode(node.typeName);
  if (name?.type === 'Identifier') {
    const imported = importedName(context, name, nativeRuntimeModule);
    return imported !== null && nativeFactories.has(imported);
  }
  if (name?.type !== 'TSQualifiedName' || name.left.type !== 'Identifier') {
    return false;
  }
  return importedName(context, name.left, nativeRuntimeModule) === '*' && nativeFactories.has(name.right.name);
};

const effectMethod = (context: Context, expression: ESTree.Node): string | null => {
  const node = unwrap(expression);
  if (node?.type === 'Identifier') {
    const name = importedName(context, node, 'effect/Effect', true);
    return name === '*' ? null : name;
  }
  if (node?.type !== 'MemberExpression' || node.object.type !== 'Identifier') {
    return null;
  }
  const property = memberName(node);
  const named = importedName(context, node.object, 'effect', true);
  if (named === 'Effect' || importedName(context, node.object, 'effect/Effect', true) === '*') {
    return property;
  }
  return null;
};

const nativeDefinition = (context: Context, expression: ESTree.Node): string | null => {
  const node = unwrap(expression);
  if (node?.type === 'Identifier') {
    const name = importedName(context, node, nativeRuntimeModule, true);
    return name !== null && nativeDefinitions.has(name) ? name : null;
  }
  if (node?.type !== 'MemberExpression' || node.object.type !== 'Identifier') {
    return null;
  }
  const name = memberName(node);
  return importedName(context, node.object, nativeRuntimeModule, true) === '*' &&
    name !== null &&
    nativeDefinitions.has(name)
    ? name
    : null;
};

const nativeDefinitionArgument = (context: Context, node: ESTree.Node, parent: Syntax | null): boolean => {
  if (parent?.type !== 'CallExpression' || parent.arguments[2] !== node) {
    return false;
  }
  const definition = nativeDefinition(context, parent.callee);
  if (definition === null || parent.arguments.some((argument: ESTree.Node) => argument.type === 'SpreadElement')) {
    return false;
  }
  const minimum = definition === 'defineRead' ? 4 : 3;
  const maximum = definition === 'defineRead' ? 6 : 4;
  return parent.arguments.length >= minimum && parent.arguments.length <= maximum;
};

const wrappedFactory = (context: Context, fn: ESTree.Node): Syntax | null => {
  const direct = skipWrappers(fn, transparentWrappers);
  const call = direct.parent;
  if (call?.type !== 'CallExpression' || call.arguments.length !== 1 || call.arguments[0] !== direct.node) {
    return null;
  }
  const method = effectMethod(context, call.callee);
  if (method === 'fn' || method === 'fnUntraced') {
    return call;
  }
  const builder = unwrap(call.callee);
  if (builder?.type !== 'CallExpression' || effectMethod(context, builder.callee) !== 'fn') {
    return null;
  }
  if (builder.arguments.length !== 1) {
    return null;
  }
  return staticString(builder.arguments[0], { templates: false }) === null ? null : call;
};

/** The three runtime arguments belong to the native transaction/scope/revision contract. */
export const isNativeServiceFactoryCallback = (context: Context, node: ESTree.Node): boolean => {
  if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') {
    return false;
  }
  if (node.params.length > 3 || node.params.some((parameter) => parameter.type !== 'Identifier')) {
    return false;
  }
  const wrapped = wrappedFactory(context, node);
  const held = skipWrappers(wrapped ?? node, transparentWrappers);
  const declaration = held.parent;
  if (nativeDefinitionArgument(context, held.node, declaration)) {
    return true;
  }
  if (declaration?.type !== 'VariableDeclarator' || declaration.init !== held.node) {
    return false;
  }
  const binding = asNode(declaration.id);
  if (binding?.type !== 'Identifier' || !nativeFactoryAnnotation(context, binding.typeAnnotation)) {
    return false;
  }
  const statement = parentOf(declaration);
  if (statement?.type !== 'VariableDeclaration' || statement.kind !== 'const') {
    return false;
  }
  const variable = lookupVariable(context, binding);
  return variable !== null && !variable.references.some((reference) => reference.isWrite() && !reference.init);
};

/** Construction must occur under a proven callback, rather than elsewhere in the importing file. */
export const isInsideNativeServiceFactoryCallback = (context: Context, node: ESTree.Node): boolean => {
  let ancestor = parentOf(node);
  while (ancestor !== null) {
    if (isNativeServiceFactoryCallback(context, ancestor)) {
      return true;
    }
    ancestor = parentOf(ancestor);
  }
  return false;
};
