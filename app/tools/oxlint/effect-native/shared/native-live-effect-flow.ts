import type { Context, ESTree, Variable } from '@oxlint/plugins';

import { keyName, memberName, nearestFunction, skipWrappers, unwrapNode, walk } from './ast.ts';
import { lookupVariable } from './bindings.ts';
import { isInErasedTypePosition } from './reference-positions.ts';

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;
type Definition = Variable['defs'][number];

const effectValues = new Set(['never', 'void']);
const effectConstructors = new Set([
  'all',
  'async',
  'die',
  'fail',
  'promise',
  'sleep',
  'succeed',
  'suspend',
  'sync',
  'try',
  'tryPromise',
]);
const effectTransforms = new Set([
  'andThen',
  'as',
  'asVoid',
  'catch',
  'catchAll',
  'catchCause',
  'catchTag',
  'delay',
  'ensuring',
  'flip',
  'map',
  'orDie',
  'provide',
  'raceFirst',
  'retry',
  'scoped',
  'tap',
  'timeout',
  'timeoutOrElse',
]);
const directTransforms = new Set(['asVoid', 'flip', 'orDie', 'scoped']);
const processModule = 'effect/unstable/process';
const rootNamespace = 'EffectRoot';
const effectNamespaces = new Set(['Effect', 'Layer', 'Deferred']);
const moduleBases = new Map<string, readonly string[]>([
  ['effect', []],
  ['effect/Effect', ['Effect']],
  ['effect/Layer', ['Layer']],
  ['effect/Deferred', ['Deferred']],
  [processModule, ['Process']],
]);

const isFunction = (node: ESTree.Node): node is FunctionNode =>
  node.type === 'ArrowFunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression';

const immutableDeclaration = (variable: Variable): ESTree.VariableDeclarator | null => {
  if (variable.defs.length !== 1 || variable.references.some((reference) => reference.isWrite() && !reference.init)) {
    return null;
  }
  const [definition] = variable.defs;
  return definition?.type === 'Variable' &&
    definition.node.type === 'VariableDeclarator' &&
    definition.parent?.type === 'VariableDeclaration' &&
    definition.parent.kind === 'const'
    ? definition.node
    : null;
};

const importPath = (definition: Definition): readonly string[] | null => {
  const declaration = definition.parent;
  const specifier = definition.node;
  if (
    definition.type !== 'ImportBinding' ||
    declaration?.type !== 'ImportDeclaration' ||
    declaration.importKind === 'type' ||
    (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
  ) {
    return null;
  }
  const source = declaration.source.value;
  const base = moduleBases.get(source);
  if (base === undefined) {
    return null;
  }
  if (specifier.type === 'ImportNamespaceSpecifier') {
    return source === 'effect' ? [rootNamespace] : base;
  }
  if (specifier.type !== 'ImportSpecifier') {
    return null;
  }
  const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
  // ChildProcess is a runtime export of the process module, not the root Effect module.
  if (source === processModule) {
    return imported === 'ChildProcess' ? ['ChildProcess'] : null;
  }
  if (imported === 'ChildProcess' && source !== processModule) {
    return null;
  }
  return [...base, imported];
};

const mutableOrRepeated = (variable: Variable): boolean =>
  variable.defs.length !== 1 || variable.references.some((reference) => reference.isWrite() && !reference.init);

const memberPath = (base: readonly string[], name: string): readonly string[] | null => {
  if (base.length === 1 && base[0] === 'Process') {
    return name === 'ChildProcess' ? ['ChildProcess'] : null;
  }
  if (base.length === 1 && base[0] === rootNamespace) {
    return effectNamespaces.has(name) ? [name] : null;
  }
  return [...base, name];
};

const destructuredPath = (
  declaration: ESTree.VariableDeclarator,
  base: readonly string[],
  identifier: string,
): readonly string[] | null => {
  if (declaration.id.type !== 'ObjectPattern') {
    return null;
  }
  for (const property of declaration.id.properties) {
    if (property.type !== 'Property' || property.value.type !== 'Identifier' || property.value.name !== identifier) {
      continue;
    }
    const name = keyName(property.key, property.computed);
    return name === null ? null : memberPath(base, name);
  }
  return null;
};

const nativePath = (context: Context, input: ESTree.Node, seen = new Set<Variable>()): readonly string[] | null => {
  const node = unwrapNode(input);
  if (node.type === 'MemberExpression') {
    const name = memberName(node);
    const base = nativePath(context, node.object, seen);
    return base !== null && name !== null ? memberPath(base, name) : null;
  }
  if (node.type !== 'Identifier') {
    return null;
  }
  const variable = lookupVariable(context, node);
  if (!variable || mutableOrRepeated(variable) || seen.has(variable)) {
    return null;
  }
  seen.add(variable);
  const [definition] = variable.defs;
  if (definition.type === 'ImportBinding') {
    return importPath(definition);
  }
  const declaration = immutableDeclaration(variable);
  if (!declaration?.init) {
    return null;
  }
  const base = nativePath(context, declaration.init, seen);
  if (base === null || declaration.id.type === 'Identifier') {
    return base;
  }
  return destructuredPath(declaration, base, node.name);
};

const nativeMethod = (context: Context, node: ESTree.Node, namespace: string): string | null => {
  const path = nativePath(context, node);
  return path?.length === 2 && path[0] === namespace ? (path[1] ?? null) : null;
};

const helperFunction = (context: Context, input: ESTree.Node): FunctionNode | null => {
  const node = unwrapNode(input);
  if (node.type !== 'Identifier') {
    return null;
  }
  const variable = lookupVariable(context, node);
  const declaration = variable ? immutableDeclaration(variable) : null;
  if (!declaration?.init || declaration.id.type !== 'Identifier') {
    return null;
  }
  const initializer = unwrapNode(declaration.init);
  return isFunction(initializer) ? initializer : null;
};

const hasNoSelfReferences = (context: Context, fn: FunctionNode): boolean => {
  if (fn.type === 'ArrowFunctionExpression' || !fn.id) {
    return true;
  }
  const variable = lookupVariable(context, fn.id);
  return (
    variable !== null &&
    !variable.references.some((reference) => reference.isRead() && !isInErasedTypePosition(reference.identifier))
  );
};

const generatorCall = (context: Context, input: ESTree.Node | null): ESTree.CallExpression | null => {
  if (!input || input.type !== 'FunctionExpression' || !input.generator || input.async) {
    return null;
  }
  if (!hasNoSelfReferences(context, input)) {
    return null;
  }
  const { node, parent } = skipWrappers(input);
  return parent?.type === 'CallExpression' &&
    parent.arguments.length === 1 &&
    parent.arguments[0] === node &&
    nativeMethod(context, parent.callee, 'Effect') === 'gen'
    ? parent
    : null;
};

const childProcessHandle = (context: Context, input: ESTree.Node): boolean => {
  const node = unwrapNode(input);
  if (node.type !== 'Identifier') {
    return false;
  }
  const variable = lookupVariable(context, node);
  const declaration = variable ? immutableDeclaration(variable) : null;
  if (!declaration?.init || declaration.id.type !== 'Identifier') {
    return false;
  }
  const initializer = unwrapNode(declaration.init);
  if (initializer.type !== 'YieldExpression' || !initializer.delegate || !initializer.argument) {
    return false;
  }
  const make = unwrapNode(initializer.argument);
  return (
    make.type === 'CallExpression' &&
    nativeMethod(context, make.callee, 'ChildProcess') === 'make' &&
    generatorCall(context, nearestFunction(initializer)) !== null
  );
};

const effectProof = {
  flatMapCallback: (context: Context, call: ESTree.CallExpression, seen: Set<FunctionNode>): boolean => {
    const index = call.arguments.length === 1 ? 0 : 1;
    const argument = call.arguments[index];
    if (call.arguments.length <= index || argument.type === 'SpreadElement') {
      return false;
    }
    const callback = unwrapNode(argument);
    return (
      isFunction(callback) &&
      hasNoSelfReferences(context, callback) &&
      effectProof.helperProducesEffect(context, callback, seen)
    );
  },

  helperProducesEffect: (context: Context, fn: FunctionNode, seen: Set<FunctionNode>): boolean => {
    if (fn.async || fn.generator || seen.has(fn)) {
      return false;
    }
    const next = new Set([...seen, fn]);
    if (fn.type === 'ArrowFunctionExpression' && fn.body.type !== 'BlockStatement') {
      return effectProof.nativeEffect(context, fn.body, next);
    }
    let returns = 0;
    let valid = true;
    if (fn.body === null) {
      return false;
    }
    walk(fn.body, context.sourceCode.visitorKeys, (node): boolean => {
      if (isFunction(node)) {
        return false;
      }
      if (node.type !== 'ReturnStatement') {
        return true;
      }
      returns += 1;
      if (!node.argument || !effectProof.nativeEffect(context, node.argument, next)) {
        valid = false;
      }
      return true;
    });
    return valid && returns > 0;
  },

  nativeEffect: (context: Context, input: ESTree.Node, seen: Set<FunctionNode>): boolean => {
    const node = unwrapNode(input);
    if (node.type === 'ConditionalExpression') {
      return (
        effectProof.nativeEffect(context, node.consequent, seen) &&
        effectProof.nativeEffect(context, node.alternate, seen)
      );
    }
    if (node.type !== 'CallExpression') {
      const method = nativeMethod(context, node, 'Effect');
      return method !== null && effectValues.has(method);
    }
    if (node.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return false;
    }
    if (effectProof.nativeEffectMethod(context, node, seen)) {
      return true;
    }
    if (nativeMethod(context, node.callee, 'Layer') === 'build') {
      return true;
    }
    if (nativeMethod(context, node.callee, 'Deferred') === 'await') {
      return true;
    }
    if (nativeMethod(context, node.callee, 'ChildProcess') === 'make') {
      return true;
    }
    const callee = unwrapNode(node.callee);
    if (
      callee.type === 'MemberExpression' &&
      memberName(callee) === 'kill' &&
      childProcessHandle(context, callee.object)
    ) {
      return true;
    }
    if (effectProof.nativePipe(context, node, seen)) {
      return true;
    }
    const fn = helperFunction(context, node.callee);
    return fn !== null && effectProof.helperProducesEffect(context, fn, seen);
  },

  nativeEffectMethod: (context: Context, node: ESTree.CallExpression, seen: Set<FunctionNode>): boolean => {
    const [first] = node.arguments;
    const method = nativeMethod(context, node.callee, 'Effect');
    if (method === 'gen') {
      return node.arguments.length === 1 && generatorCall(context, unwrapNode(first)) === node;
    }
    if (method === 'flatMap') {
      return (
        node.arguments.length === 2 &&
        effectProof.nativeEffect(context, first, seen) &&
        effectProof.flatMapCallback(context, node, seen)
      );
    }
    if (method !== null && effectConstructors.has(method)) {
      return true;
    }
    if (method !== null && effectTransforms.has(method)) {
      const arity = directTransforms.has(method) ? 1 : 2;
      return node.arguments.length === arity && effectProof.nativeEffect(context, first, seen);
    }
    return false;
  },

  nativePipe: (context: Context, node: ESTree.CallExpression, seen: Set<FunctionNode>): boolean => {
    const callee = unwrapNode(node.callee);
    return (
      callee.type === 'MemberExpression' &&
      memberName(callee) === 'pipe' &&
      effectProof.nativeEffect(context, callee.object, seen) &&
      node.arguments.every(
        (argument) => argument.type !== 'SpreadElement' && effectProof.nativeTransform(context, argument, seen),
      )
    );
  },

  nativeTransform: (context: Context, input: ESTree.Node, seen: Set<FunctionNode>): boolean => {
    const node = unwrapNode(input);
    if (node.type !== 'CallExpression') {
      const method = nativeMethod(context, node, 'Effect');
      return method !== null && directTransforms.has(method);
    }
    if (node.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return false;
    }
    const method = nativeMethod(context, node.callee, 'Effect');
    if (method === 'flatMap') {
      return node.arguments.length === 1 && effectProof.flatMapCallback(context, node, seen);
    }
    return (
      method !== null && effectTransforms.has(method) && !directTransforms.has(method) && node.arguments.length === 1
    );
  },
};

/** Only immutable local helper calls and imported Effect constructors establish native result identity. */
export const isNativeEffectHelper = (context: Context, fn: ESTree.Node): boolean => {
  const node = unwrapNode(fn);
  return isFunction(node) && effectProof.helperProducesEffect(context, node, new Set());
};

const flatMapCall = (context: Context, fn: FunctionNode): ESTree.CallExpression | null => {
  if (!hasNoSelfReferences(context, fn)) {
    return null;
  }
  const { node, parent } = skipWrappers(fn);
  if (parent?.type !== 'CallExpression' || nativeMethod(context, parent.callee, 'Effect') !== 'flatMap') {
    return null;
  }
  const index = parent.arguments.length === 1 ? 0 : 1;
  if (parent.arguments[index] !== node) {
    return null;
  }
  return (parent.arguments.length === 1 && effectProof.nativeTransform(context, parent, new Set())) ||
    effectProof.nativeEffect(context, parent, new Set())
    ? parent
    : null;
};

const returnedBoundary = (context: Context, fn: FunctionNode): ESTree.Node | null => {
  if (fn.generator || fn.async) {
    return null;
  }
  const deferred = flatMapCall(context, fn);
  return deferred ?? fn;
};

const argumentConsumesEffect = (context: Context, call: ESTree.CallExpression, argument: ESTree.Node): boolean => {
  if (effectProof.nativePipe(context, call, new Set())) {
    return call.arguments.some((candidate) => candidate === argument);
  }
  const method = nativeMethod(context, call.callee, 'Effect');
  if (method === null || call.arguments[0] !== argument || !effectProof.nativeEffect(context, call, new Set())) {
    return false;
  }
  return method === 'flatMap' || effectTransforms.has(method);
};

const nativeContainer = (context: Context, node: ESTree.Node, parent: ESTree.Node): ESTree.Node | null => {
  if (parent.type === 'ConditionalExpression' && (parent.consequent === node || parent.alternate === node)) {
    return effectProof.nativeEffect(context, parent, new Set()) ? parent : null;
  }
  if (parent.type === 'MemberExpression' && parent.object === node && memberName(parent) === 'pipe') {
    const outer = skipWrappers(parent);
    return outer.parent?.type === 'CallExpression' &&
      outer.parent.callee === outer.node &&
      effectProof.nativePipe(context, outer.parent, new Set())
      ? outer.parent
      : null;
  }
  if (parent.type === 'CallExpression' && argumentConsumesEffect(context, parent, node)) {
    return parent;
  }
  return null;
};

const ownershipProof = {
  consumedOwner: (context: Context, input: ESTree.Node, seen: Set<ESTree.Node>): ESTree.Node | null => {
    if (seen.has(input)) {
      return null;
    }
    seen.add(input);
    const { node, parent } = skipWrappers(input);
    if (!parent) {
      return null;
    }
    if (parent.type === 'ArrowFunctionExpression' && parent.body === node) {
      return ownershipProof.returnedOwner(context, parent, seen);
    }
    if (parent.type === 'ReturnStatement' && parent.argument === node) {
      const fn = nearestFunction(parent);
      return fn && isFunction(fn) ? ownershipProof.returnedOwner(context, fn, seen) : null;
    }
    if (parent.type === 'YieldExpression' && parent.argument === node && parent.delegate) {
      const call = generatorCall(context, nearestFunction(parent));
      return call ? ownershipProof.consumedOwner(context, call, seen) : null;
    }
    const container = nativeContainer(context, node, parent);
    return container ? ownershipProof.consumedOwner(context, container, seen) : null;
  },

  returnedOwner: (context: Context, fn: FunctionNode, seen: Set<ESTree.Node>): ESTree.Node | null => {
    const boundary = returnedBoundary(context, fn);
    if (boundary === null || isFunction(boundary)) {
      return boundary;
    }
    return ownershipProof.consumedOwner(context, boundary, seen);
  },
};

/** Find the function which consumes a timer's deferred Effect result, skipping only proven native callbacks. */
export const nativeClockExecutionOwner = (context: Context, input: ESTree.Node): ESTree.Node | null => {
  const node = unwrapNode(input);
  if (node.type === 'CallExpression') {
    return effectProof.nativeEffect(context, node, new Set())
      ? ownershipProof.consumedOwner(context, node, new Set())
      : null;
  }
  const outer = skipWrappers(node);
  const expression =
    outer.parent?.type === 'CallExpression' && outer.parent.callee === outer.node ? outer.parent : outer.node;
  if (
    !effectProof.nativeEffect(context, expression, new Set()) &&
    !effectProof.nativeTransform(context, expression, new Set())
  ) {
    return null;
  }
  return ownershipProof.consumedOwner(context, expression, new Set());
};
