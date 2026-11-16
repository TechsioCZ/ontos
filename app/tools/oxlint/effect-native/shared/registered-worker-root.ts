import type { Context, ESTree } from '@oxlint/plugins';

import { keyName, memberName, unwrapNode } from './ast.ts';
import { lookupVariable } from './bindings.ts';

type Identifier = Extract<ESTree.Node, { type: 'Identifier' }>;
const compositionMembers = new Set(['merge', 'mergeAll', 'provide', 'provideMerge', 'orDie']);
const maxCompositionHops = 64;

const namedImportDefinition = (context: Context, node: ESTree.Node, source: string, name: string): boolean => {
  const value = unwrapNode(node);
  if (value.type !== 'Identifier') {
    return false;
  }
  const variable = lookupVariable(context, value);
  if (variable?.defs.length !== 1) {
    return false;
  }
  const [definition] = variable.defs;
  return (
    definition?.type === 'ImportBinding' &&
    definition.parent?.type === 'ImportDeclaration' &&
    definition.parent.source.value === source &&
    definition.parent.importKind !== 'type' &&
    definition.node.type === 'ImportSpecifier' &&
    definition.node.importKind !== 'type' &&
    definition.node.imported.type === 'Identifier' &&
    definition.node.imported.name === name
  );
};

const nativeTokenConsumer = (context: Context, node: ESTree.Node): boolean => {
  const callee = unwrapNode(node);
  if (callee.type !== 'MemberExpression' || callee.computed || callee.optional) {
    return false;
  }
  return (
    (memberName(callee) === 'provideService' && namedImportDefinition(context, callee.object, 'effect', 'Effect')) ||
    (memberName(callee) === 'effect' && namedImportDefinition(context, callee.object, 'effect', 'Layer'))
  );
};

const directImportUse = (context: Context, identifier: ESTree.Node, parent: ESTree.Node | null): boolean => {
  if (parent?.type === 'YieldExpression') {
    return parent.argument === identifier && parent.delegate;
  }
  if (parent?.type !== 'CallExpression') {
    return false;
  }
  if (parent.callee === identifier) {
    return true;
  }
  return parent.arguments[0] === identifier && nativeTokenConsumer(context, parent.callee);
};

const referenceIsClosed = (context: Context, identifier: ESTree.Node): boolean => {
  let value = identifier;
  while (value.parent?.type === 'MemberExpression' && value.parent.object === value) {
    value = value.parent;
  }
  const { parent } = value;
  if (parent?.type === 'AssignmentExpression' && parent.left === value) {
    return false;
  }
  if (parent?.type === 'UpdateExpression' && parent.argument === value) {
    return false;
  }
  if (parent?.type === 'UnaryExpression' && parent.operator === 'delete' && parent.argument === value) {
    return false;
  }
  if (value !== identifier) {
    return true;
  }
  return directImportUse(context, identifier, parent);
};
const importedBindingIsClosed = (context: Context, identifier: Identifier): boolean => {
  const variable = lookupVariable(context, identifier);
  return (
    variable !== null &&
    variable.references.every((reference) => !reference.isWrite() && referenceIsClosed(context, reference.identifier))
  );
};

const namedImport = (context: Context, node: ESTree.Node, source: string, name: string): boolean => {
  const value = unwrapNode(node);
  return (
    value.type === 'Identifier' &&
    namedImportDefinition(context, value, source, name) &&
    importedBindingIsClosed(context, value)
  );
};

const nativeMember = (context: Context, node: ESTree.Node, namespace: string, name: string): boolean => {
  const value = unwrapNode(node);
  return (
    value.type === 'MemberExpression' &&
    !value.computed &&
    !value.optional &&
    memberName(value) === name &&
    namedImport(context, value.object, 'effect', namespace)
  );
};

const immutableDeclaration = (context: Context, id: Identifier): ESTree.VariableDeclarator | null => {
  const variable = lookupVariable(context, id);
  if (variable?.defs.length !== 1 || variable.references.some((reference) => reference.isWrite() && !reference.init)) {
    return null;
  }
  const declaration = variable.defs[0]?.node;
  return declaration?.type === 'VariableDeclarator' &&
    declaration.parent?.type === 'VariableDeclaration' &&
    declaration.parent.kind === 'const' &&
    declaration.id.type === 'Identifier'
    ? declaration
    : null;
};

/** Imported tag identity, including namespace members, without trusting local spelling. */
const sameImportedTag = (context: Context, left: ESTree.Node, right: ESTree.Node): boolean => {
  const lhs = unwrapNode(left);
  const rhs = unwrapNode(right);
  if (lhs.type === 'MemberExpression' && rhs.type === 'MemberExpression') {
    return (
      !lhs.computed &&
      !rhs.computed &&
      !lhs.optional &&
      !rhs.optional &&
      memberName(lhs) === memberName(rhs) &&
      sameImportedTag(context, lhs.object, rhs.object)
    );
  }
  if (lhs.type !== 'Identifier' || rhs.type !== 'Identifier' || !importedBindingIsClosed(context, lhs)) {
    return false;
  }
  const binding = lookupVariable(context, lhs);
  return (
    binding !== null &&
    binding === lookupVariable(context, rhs) &&
    binding.defs.length === 1 &&
    binding.defs[0]?.type === 'ImportBinding' &&
    binding.defs[0].parent?.type === 'ImportDeclaration' &&
    binding.defs[0].parent.importKind !== 'type' &&
    (binding.defs[0].node.type !== 'ImportSpecifier' || binding.defs[0].node.importKind !== 'type')
  );
};

const isNativeCompositionCall = (context: Context, node: ESTree.CallExpression): boolean => {
  const callee = unwrapNode(node.callee);
  return (
    !node.optional &&
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    !callee.optional &&
    compositionMembers.has(memberName(callee) ?? '') &&
    namedImport(context, callee.object, 'effect', 'Layer')
  );
};

/** Only native Layer combinators can carry a local closure into the registered root. */
const isLayerExpression = (context: Context, node: ESTree.Node, hops = 0): boolean => {
  if (hops >= maxCompositionHops) {
    return false;
  }
  const value = unwrapNode(node);
  if (value.type === 'CallExpression' && isNativeCompositionCall(context, value)) {
    return true;
  }
  if (value.type !== 'CallExpression' || value.optional) {
    return false;
  }
  const callee = unwrapNode(value.callee);
  return (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    !callee.optional &&
    memberName(callee) === 'pipe' &&
    isLayerExpression(context, callee.object, hops + 1) &&
    value.arguments.every(
      (argument) =>
        argument.type !== 'SpreadElement' &&
        (argument.type === 'CallExpression'
          ? isNativeCompositionCall(context, argument)
          : nativeMember(context, argument, 'Layer', 'orDie')),
    )
  );
};

const isExportedRoot = (call: ESTree.CallExpression): boolean => {
  const declaration = call.parent;
  const statement = declaration?.parent;
  return (
    declaration?.type === 'VariableDeclarator' &&
    declaration.init === call &&
    declaration.id.type === 'Identifier' &&
    statement?.type === 'VariableDeclaration' &&
    statement.kind === 'const' &&
    statement.parent?.type === 'ExportNamedDeclaration' &&
    statement.parent.parent?.type === 'Program'
  );
};
const hasUniqueLayer = (options: ESTree.ObjectExpression): boolean => {
  if (options.properties.some((field) => field.type !== 'Property' || field.computed)) {
    return false;
  }
  return (
    options.properties.filter((field) => field.type === 'Property' && keyName(field.key, field.computed) === 'layer')
      .length === 1
  );
};
const exportedWorkerLayer = (context: Context, property: Extract<ESTree.Node, { type: 'Property' }>): boolean => {
  if (
    property.computed ||
    property.kind !== 'init' ||
    property.method ||
    keyName(property.key, property.computed) !== 'layer'
  ) {
    return false;
  }
  const options = property.parent;
  const call = options?.parent;
  return (
    options?.type === 'ObjectExpression' &&
    call?.type === 'CallExpression' &&
    !call.optional &&
    call.arguments.length === 1 &&
    call.arguments[0] === options &&
    namedImport(context, call.callee, '@app/core-runtime/outbox/worker', 'defineOutboxWorkerEntry') &&
    hasUniqueLayer(options) &&
    isExportedRoot(call)
  );
};

const flowsToExportedWorker = (context: Context, reference: ESTree.Node): boolean => {
  let child = reference;
  for (let hops = 0; hops < maxCompositionHops; hops += 1) {
    const { parent } = child;
    if (parent?.type === 'Property' && parent.value === child) {
      return exportedWorkerLayer(context, parent);
    }
    const position = child;
    if (parent?.type !== 'CallExpression' || !parent.arguments.some((argument) => argument === position)) {
      return false;
    }
    if (!isNativeCompositionCall(context, parent) && !isLayerExpression(context, parent)) {
      return false;
    }
    child = parent;
  }
  return false;
};

const exclusivelyRegisteredLayer = (context: Context, layer: ESTree.CallExpression): boolean => {
  const declaration = layer.parent;
  if (
    declaration?.type !== 'VariableDeclarator' ||
    declaration.init !== layer ||
    declaration.id.type !== 'Identifier' ||
    immutableDeclaration(context, declaration.id) !== declaration ||
    declaration.parent?.parent?.type !== 'Program'
  ) {
    return false;
  }
  const variable = lookupVariable(context, declaration.id);
  const reads = variable?.references.filter((reference) => reference.isRead()) ?? [];
  return reads.length > 0 && reads.every((reference) => flowsToExportedWorker(context, reference.identifier));
};

/**
 * A closed service at the worker composition root may bind values captured from its own Layer R.
 * The local Layer cannot escape to a library, and arbitrary locally supplied values remain errors.
 */
const capturedCallback = (context: Context, tag: ESTree.Node, supplied: Identifier): ESTree.Node | null => {
  const declaration = immutableDeclaration(context, supplied);
  const acquisition = declaration?.init;
  if (
    declaration === null ||
    acquisition?.type !== 'YieldExpression' ||
    !acquisition.delegate ||
    acquisition.argument === null ||
    !sameImportedTag(context, tag, acquisition.argument)
  ) {
    return null;
  }
  const block = declaration.parent?.parent;
  const callback = block?.parent;
  return block?.type === 'BlockStatement' &&
    callback?.type === 'FunctionExpression' &&
    callback.generator &&
    callback.body === block
    ? callback
    : null;
};
const registeredCallback = (context: Context, generator: ESTree.Node): boolean => {
  const program = generator.parent;
  const layer = program?.parent;
  if (
    program?.type !== 'CallExpression' ||
    program.arguments.length !== 1 ||
    program.arguments[0] !== generator ||
    !nativeMember(context, program.callee, 'Effect', 'gen')
  ) {
    return false;
  }
  return (
    layer?.type === 'CallExpression' &&
    layer.arguments.length === 2 &&
    layer.arguments[1] === program &&
    nativeMember(context, layer.callee, 'Layer', 'effect') &&
    exclusivelyRegisteredLayer(context, layer)
  );
};
export const isCapturedWorkerRootServiceProvision = (context: Context, node: ESTree.Node): boolean => {
  const call = node.parent;
  if (call?.type !== 'CallExpression' || call.callee !== node || call.optional || call.arguments.length !== 2) {
    return false;
  }
  const [tag, supplied] = call.arguments;
  if (tag === undefined || tag.type === 'SpreadElement' || supplied?.type !== 'Identifier') {
    return false;
  }
  const callback = capturedCallback(context, tag, supplied);
  if (callback === null) {
    return false;
  }
  let ancestor: ESTree.Node | null = node.parent;
  while (ancestor !== null && ancestor !== callback) {
    ancestor = ancestor.parent;
  }
  return ancestor === callback && registeredCallback(context, callback);
};
