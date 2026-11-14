import type { Context, ESTree } from '@oxlint/plugins';

import { asNode, memberName, parentOf, skipWrappers, staticString, unwrap, walk } from './ast.ts';
import type { Syntax } from './ast.ts';
import { lookupVariable } from './bindings.ts';
import { scopePath } from './paths.ts';

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

const nativeFactoryAnnotation = (context: Context, annotation: ESTree.Node | null | undefined): string | null => {
  let node = asNode(annotation);
  if (node?.type === 'TSTypeAnnotation') {
    node = asNode(node.typeAnnotation);
  }
  if (node?.type !== 'TSTypeReference') {
    return null;
  }
  const name = asNode(node.typeName);
  if (name?.type === 'Identifier') {
    const imported = importedName(context, name, nativeRuntimeModule);
    return imported !== null && nativeFactories.has(imported) ? imported : null;
  }
  if (name?.type !== 'TSQualifiedName' || name.left.type !== 'Identifier') {
    return null;
  }
  return importedName(context, name.left, nativeRuntimeModule) === '*' && nativeFactories.has(name.right.name)
    ? name.right.name
    : null;
};

/**
 * The runtime arguments a native factory receives: an Action factory takes transaction, scope and
 * composition revision; a read factory also takes the list-access predicate the runtime derives
 * for a selector-bearing read.
 */
const nativeFactoryArity = (factory: string): number =>
  factory === 'ReadServiceFactory' || factory === 'defineRead' ? 4 : 3;

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

const nativeDefinitionArgument = (context: Context, node: ESTree.Node, parent: Syntax | null): string | null => {
  if (parent?.type !== 'CallExpression' || parent.arguments[2] !== node) {
    return null;
  }
  const definition = nativeDefinition(context, parent.callee);
  if (definition === null || parent.arguments.some((argument: ESTree.Node) => argument.type === 'SpreadElement')) {
    return null;
  }
  // A v2 read carries only descriptor, handler and service factory; its legacy target resolvers are optional.
  const minimum = 3;
  const maximum = definition === 'defineRead' ? 6 : 5;
  return parent.arguments.length >= minimum && parent.arguments.length <= maximum ? definition : null;
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

/** The runtime arguments belong to the native transaction/scope/revision (and, for reads, list-access) contract. */
export const isNativeServiceFactoryCallback = (context: Context, node: ESTree.Node): boolean => {
  if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') {
    return false;
  }
  if (node.params.some((parameter) => parameter.type !== 'Identifier')) {
    return false;
  }
  const wrapped = wrappedFactory(context, node);
  const held = skipWrappers(wrapped ?? node, transparentWrappers);
  const declaration = held.parent;
  const definition = nativeDefinitionArgument(context, held.node, declaration);
  if (definition !== null) {
    return node.params.length <= nativeFactoryArity(definition);
  }
  if (declaration?.type !== 'VariableDeclarator' || declaration.init !== held.node) {
    return false;
  }
  const binding = asNode(declaration.id);
  const factory = binding?.type === 'Identifier' ? nativeFactoryAnnotation(context, binding.typeAnnotation) : null;
  if (binding?.type !== 'Identifier' || factory === null || node.params.length > nativeFactoryArity(factory)) {
    return false;
  }
  const statement = parentOf(declaration);
  if (statement?.type !== 'VariableDeclaration' || statement.kind !== 'const') {
    return false;
  }
  const variable = lookupVariable(context, binding);
  return variable !== null && !variable.references.some((reference) => reference.isWrite() && !reference.init);
};

const isNativeAcquisitionPipeReference = (node: ESTree.Node, acquired: ESTree.Node | null | undefined): boolean => {
  if (
    acquired?.type !== 'CallExpression' ||
    acquired.callee.type !== 'MemberExpression' ||
    memberName(acquired.callee) !== 'pipe' ||
    acquired.callee.object.type !== 'Identifier'
  ) {
    return false;
  }
  const provision = node.parent;
  if (
    acquired.callee.object !== node &&
    !(provision?.type === 'CallExpression' && provision.callee === node && acquired.arguments.includes(provision))
  ) {
    return false;
  }
  return true;
};

/** A const service acquisition in the native transaction factory is owner composition.
 * Only the directly yielded pipeline qualifies; nested handlers and escaped effects do not.
 */
export const isNativeServiceFactoryAcquisition = (context: Context, node: ESTree.Node): boolean => {
  let ancestor: ESTree.Node | null = parentOf(node);
  while (ancestor !== null && ancestor.type !== 'YieldExpression') {
    if (['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(ancestor.type)) {
      return false;
    }
    ancestor = parentOf(ancestor);
  }
  if (
    ancestor?.type !== 'YieldExpression' ||
    !ancestor.delegate ||
    ancestor.parent?.type !== 'VariableDeclarator' ||
    ancestor.parent.parent?.type !== 'VariableDeclaration' ||
    ancestor.parent.parent.kind !== 'const'
  ) {
    return false;
  }
  if (!isNativeAcquisitionPipeReference(node, ancestor.argument)) {
    return false;
  }
  let owner: ESTree.Node | null = parentOf(ancestor.parent.parent);
  while (owner !== null) {
    if (['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration'].includes(owner.type)) {
      return isNativeServiceFactoryCallback(context, owner);
    }
    owner = parentOf(owner);
  }
  return false;
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

const isExportedReadTestHarness = (context: Context, wrapped: ESTree.Node): boolean => {
  const declaration = parentOf(wrapped);
  if (declaration?.type !== 'VariableDeclarator' || declaration.init !== wrapped) {
    return false;
  }
  const binding = asNode(declaration.id);
  if (binding?.type !== 'Identifier' || binding.name !== 'makeReadTestHarness') {
    return false;
  }
  const statement = parentOf(declaration);
  if (statement?.type !== 'VariableDeclaration' || statement.kind !== 'const') {
    return false;
  }
  const exported = parentOf(statement);
  if (exported?.type !== 'ExportNamedDeclaration' || parentOf(exported)?.type !== 'Program') {
    return false;
  }
  const variable = lookupVariable(context, binding);
  return variable !== null && !variable.references.some((reference) => reference.isWrite() && !reference.init);
};

const hasReadTestComposition = (context: Context, body: ESTree.Node): boolean => {
  let runtime = false;
  let driver = false;
  walk(body, context.sourceCode.visitorKeys, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') {
      return;
    }
    runtime ||= importedName(context, node.callee, '../reads/runtime.ts', true) === 'makeReadRuntime';
    driver ||= importedName(context, node.callee, './scripted-pg-client.ts', true) === 'scriptedPgClientLayer';
  });
  return runtime && driver;
};

/** Core's public Read harness is a scoped test composition root, not a business factory.
 * Recognition is limited to its exported callback and real owner-local runtime/driver calls;
 * unrelated helpers in the same module and other testing directories remain governed. */
export const isCoreReadTestHarnessCallback = (context: Context, node: ESTree.Node): boolean => {
  if (scopePath(context.filename) !== 'packages/core-runtime/src/testing/reads.ts') {
    return false;
  }
  if (node.type !== 'ArrowFunctionExpression' && node.type !== 'FunctionExpression') {
    return false;
  }
  const wrapped = wrappedFactory(context, node);
  return (
    wrapped !== null &&
    isExportedReadTestHarness(context, wrapped) &&
    node.body !== null &&
    hasReadTestComposition(context, node.body)
  );
};

export const isInsideCoreReadTestHarnessCallback = (context: Context, node: ESTree.Node): boolean => {
  let ancestor = parentOf(node);
  while (ancestor !== null) {
    if (isCoreReadTestHarnessCallback(context, ancestor)) {
      return true;
    }
    ancestor = parentOf(ancestor);
  }
  return false;
};
