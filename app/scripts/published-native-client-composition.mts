import path from 'node:path';

import type { GraphValue, ModuleGraph, SourceModule } from '@modern-js/code-tools/microvertical-api-boundary';
import { getBindingIdentifiers, isFunction, traverseFast } from '@babel/types';
import { hasInvocationOwnedData } from './native-invocation-ownership.mts';
import type { ExportAllDeclaration, ExportNamedDeclaration, ImportDeclaration, Node, Statement } from '@babel/types';

/**
 * Consumer-side proof for an authored native client composition published through a proven
 * `./api/client` aggregate.
 *
 * The boundary checker proves the aggregate itself (`delegatedClientModules`): the original
 * generated factory/API and the enrolled generated leaf modules. A hand-authored module the
 * aggregate re-exports carries no generator marker, so this module proves the *selected*
 * hand-authored export instead: it adds no raw authority beyond the enrolled operations and native
 * data APIs it invokes. The enrolled callback comes from the existing checker, so a generated marker
 * alone is never trusted as new authorization; the walk stops at those proven leaves.
 *
 * The proof is about authority, not semantics. It never claims a composition forwards payload,
 * correlation or CAS fields unchanged: a composition intentionally constructs native commands, so
 * unchanged payload/CAS behavior stays owned by the runtime workflow tests.
 *
 * Accepted invocation authority is exactly: original enrolled governed read/command operations
 * (`isEnrolledOperation`), safe native Effect/Random/Option/DateTime/Schema/Predicate/Brand data
 * APIs, and owner-local non-private closed data functions and classes followed through the graph.
 *
 * Rejected: raw network/HTTP/DB/global authority, private handler origins, eager module-scope
 * execution, unknown or foreign providers, a rebound or shadowed native namespace, and mutation of
 * anything but the invocation's own local data. Local mutation of an invocation-owned value object is
 * legitimate, so a blanket `module.mutations.length !== 0` ban is deliberately not used.
 *
 * Module-wide controls apply to the module that declares the selected export: an unused network
 * import, or an eager effect beside the selected export, rejects the composition even when the
 * selected function never calls it.
 */

/** Native Effect data namespaces a published composition may invoke. */
const NATIVE_DATA_NAMESPACES = new Set([
  'Brand',
  'DateTime',
  'Effect',
  'Option',
  'Predicate',
  'Random',
  'Schema',
  'SchemaGetter',
]);
/** The `Effect.fn` builders that wrap a generator without running it. */
const EFFECT_FN_MEMBERS = new Set(['fn', 'fnUntraced']);
/** `Effect` runners execute eagerly, so a composition may never call one. */
const EAGER_EFFECT_PREFIX = 'run';
/** Module-scope nodes that are eager work rather than inert data. */
const NON_INERT_NODE_TYPES = new Set([
  'AssignmentExpression',
  'UpdateExpression',
  'AwaitExpression',
  'ImportExpression',
  'NewExpression',
  'StaticBlock',
  'TaggedTemplateExpression',
  'YieldExpression',
]);
/** Value-carrying TypeScript expressions; every other `TS*` node is type syntax, never authority. */
const TS_VALUE_CARRIERS = new Set([
  'TSAsExpression',
  'TSEnumDeclaration',
  'TSInstantiationExpression',
  'TSModuleDeclaration',
  'TSNonNullExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
]);
/** One cross-MicroVertical consumer import of an authored native client composition. */
export interface PublishedNativeClientComposition {
  /** The native workspace module graph the checker already holds. */
  readonly graph: ModuleGraph;
  /** The checker's immutable-capture proof for one owner routine. */
  readonly hasImmutableCapture: (module: SourceModule, expression: Node) => boolean;
  /** True only for an original enrolled governed operation leaf the checker proved. */
  readonly isEnrolledOperation: (module: SourceModule, expression: Node) => boolean;
  /** Optional proof for a closed native schema node; consulted for call expressions only. */
  readonly isNativeSchemaNode?: ((module: SourceModule, node: Node) => boolean) | undefined;
  /** Owner-local, non-private identity for a resolved module. */
  readonly isOwnerLocalNonPrivate: (module: SourceModule) => boolean;
  /** The selected export the checker resolved, for example `listCustomers`. */
  readonly selected: { readonly expression: Node; readonly module: SourceModule };
}

interface CompositionUnit {
  readonly expression: Node;
  readonly module: SourceModule;
}

interface Span {
  readonly end: number;
  readonly start: number;
}

const spanOf = (node: Node): Span | undefined => {
  const { end, start } = node;
  return start === null || start === undefined || end === null || end === undefined ? undefined : { end, start };
};

const insideSpan = (node: Node, span: Span): boolean => {
  const { end, start } = node;
  return (
    start !== null && start !== undefined && end !== null && end !== undefined && start >= span.start && end <= span.end
  );
};

const isTypeSyntax = (node: Node): boolean => node.type.startsWith('TS') && !TS_VALUE_CARRIERS.has(node.type);

/**
 * Walk `expression` without entering type syntax or a subtree `isPruneRoot` claims. Pruned subtrees
 * are collected as spans first because the Babel fast walker cannot skip a node in flight.
 */
const walk = (expression: Node, isPruneRoot: (node: Node) => boolean, visit: (node: Node) => void): void => {
  const pruned: Span[] = [];
  traverseFast(expression, (node) => {
    if (isTypeSyntax(node) || isPruneRoot(node)) {
      const span = spanOf(node);
      if (span !== undefined) {
        pruned.push(span);
      }
    }
  });
  traverseFast(expression, (node) => {
    if (!pruned.some((span) => insideSpan(node, span))) {
      visit(node);
    }
  });
};

const isFunctionExpression = (node: Node): boolean =>
  node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression';

/** The native namespace and accessed members an external value names, or `undefined` when foreign. */
const externalNamespace = (
  value: GraphValue,
): { readonly members: readonly string[]; readonly namespace: string } | undefined => {
  if (value.kind !== 'external') {
    return undefined;
  }
  if (value.specifier === 'effect') {
    return { members: value.members, namespace: value.name };
  }
  if (!value.specifier.startsWith('effect/')) {
    return undefined;
  }
  return {
    members: value.name === '*' ? value.members : [value.name, ...value.members],
    namespace: value.specifier.slice('effect/'.length),
  };
};

/** True for a safe native data value; an `Effect` runner is authority, never data. */
const isNativeDataValue = (value: GraphValue): boolean => {
  const external = externalNamespace(value);
  if (external === undefined || !NATIVE_DATA_NAMESPACES.has(external.namespace)) {
    return false;
  }
  const [head] = external.members;
  return !(external.namespace === 'Effect' && head !== undefined && head.startsWith(EAGER_EFFECT_PREFIX));
};

const isEffectFnValue = (value: GraphValue): boolean => {
  const external = externalNamespace(value);
  return (
    external !== undefined &&
    external.namespace === 'Effect' &&
    external.members.length === 1 &&
    EFFECT_FN_MEMBERS.has(external.members[0] ?? '')
  );
};

/**
 * True when the values name the accepted native identity at least once and never name a foreign
 * provider. The graph over-approximates a namespace read with a companion `unresolved` value, so the
 * foreign test is what rejects a rebound or forged provider.
 */
const namesNativeValue = (values: readonly GraphValue[], accept: (value: GraphValue) => boolean): boolean =>
  values.some(accept) && values.every((value) => value.kind !== 'external' || accept(value));

/** The generator of an `Effect.fn(label)(generator)` wrapper, or `undefined` for anything else. */
const effectFnGenerator = (graph: ModuleGraph, module: SourceModule, expression: Node): Node | undefined => {
  if (expression.type !== 'CallExpression' || expression.arguments.length !== 1) {
    return undefined;
  }
  const [generator] = expression.arguments;
  if (generator === undefined || !isFunctionExpression(generator)) {
    return undefined;
  }
  const { callee } = expression;
  if (
    callee.type !== 'CallExpression' ||
    callee.arguments.length !== 1 ||
    callee.arguments[0]?.type !== 'StringLiteral'
  ) {
    return undefined;
  }
  return namesNativeValue(graph.evaluate(module, callee.callee), isEffectFnValue) ? generator : undefined;
};

/** A call is a native data constructor when its callee, through chained calls, is native data. */
const nativeDataCall = (graph: ModuleGraph, module: SourceModule, callee: Node, visited = new Set<Node>()): boolean => {
  if (visited.has(callee)) {
    return false;
  }
  const seen = new Set(visited).add(callee);
  if (
    (callee.type === 'Identifier' || callee.type === 'MemberExpression') &&
    namesNativeValue(graph.evaluate(module, callee), isNativeDataValue)
  ) {
    return true;
  }
  if (callee.type === 'CallExpression') {
    return nativeDataCall(graph, module, callee.callee, seen);
  }
  if (
    callee.type !== 'MemberExpression' ||
    callee.computed ||
    callee.property.type !== 'Identifier' ||
    !['check', 'pipe'].includes(callee.property.name)
  ) {
    return false;
  }
  if (callee.object.type === 'CallExpression') {
    return nativeDataCall(graph, module, callee.object.callee, seen);
  }
  if (namesNativeValue(graph.evaluate(module, callee.object), isNativeDataValue)) {
    return true;
  }
  const binding = graph.resolveReference(module, callee.object);
  return (
    binding?.kind === 'declaration' &&
    binding.expression.type === 'CallExpression' &&
    nativeDataCall(graph, binding.module, binding.expression.callee, seen)
  );
};

const isUnboundGlobal = (graph: ModuleGraph, module: SourceModule, node: Node): boolean =>
  node.type === 'Identifier' && graph.isUnboundReference(module, node) && node.name !== 'undefined';

const hasForeignMemberValue = (graph: ModuleGraph, module: SourceModule, node: Node): boolean =>
  node.type === 'MemberExpression' &&
  graph.evaluate(module, node).some((value) => value.kind === 'external' && !isNativeDataValue(value));

const isPipeCall = (node: Node): boolean =>
  node.type === 'CallExpression' &&
  node.callee.type === 'MemberExpression' &&
  !node.callee.computed &&
  node.callee.property.type === 'Identifier' &&
  node.callee.property.name === 'pipe';

const hasNativePipeArguments = (input: PublishedNativeClientComposition, module: SourceModule, node: Node): boolean => {
  if (node.type !== 'CallExpression' || !isPipeCall(node)) {
    return true;
  }
  return node.arguments.every(
    (argument) =>
      isFunctionExpression(argument) ||
      (argument.type === 'CallExpression' && nativeDataCall(input.graph, module, argument.callee)) ||
      namesNativeValue(input.graph.evaluate(module, argument), isNativeDataValue),
  );
};

/** Module-scope initializers must be inert data or a native data constructor, never eager work. */
const isInert = (
  input: PublishedNativeClientComposition,
  module: SourceModule,
  expression: Node,
  active = new Set<Node>(),
): boolean => {
  if (active.has(expression)) {
    return false;
  }
  const seen = new Set(active).add(expression);
  const localFactoryCall = (node: Node): boolean => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') {
      return false;
    }
    const binding = input.graph.resolveReference(module, node.callee);
    return (
      binding?.kind === 'declaration' &&
      binding.expression.type === 'ArrowFunctionExpression' &&
      !binding.expression.async &&
      binding.expression.params.every((parameter) => parameter.type === 'Identifier') &&
      input.isOwnerLocalNonPrivate(binding.module) &&
      isInert(input, binding.module, binding.expression.body, seen)
    );
  };
  let inert = true;
  const eagerCallbacks = new Set<Node>();
  traverseFast(expression, (node) => {
    if (node.type === 'CallExpression' && isPipeCall(node)) {
      for (const argument of node.arguments) {
        if (isFunctionExpression(argument)) {
          eagerCallbacks.add(argument);
        }
      }
    }
  });
  const isPruneRoot = (node: Node): boolean =>
    (isFunctionExpression(node) && !eagerCallbacks.has(node)) ||
    (node.type === 'CallExpression' && input.isNativeSchemaNode?.(module, node) === true);
  walk(expression, isPruneRoot, (node) => {
    if (
      NON_INERT_NODE_TYPES.has(node.type) ||
      isUnboundGlobal(input.graph, module, node) ||
      !hasNativePipeArguments(input, module, node)
    ) {
      inert = false;
    }
    if (hasForeignMemberValue(input.graph, module, node)) {
      inert = false;
    }
    if (
      node.type === 'CallExpression' &&
      !nativeDataCall(input.graph, module, node.callee) &&
      effectFnGenerator(input.graph, module, node) === undefined &&
      !localFactoryCall(node)
    ) {
      inert = false;
    }
  });
  return inert;
};

const hasInertDeclaration = (input: PublishedNativeClientComposition, module: SourceModule, node: Node): boolean => {
  if (node.type === 'ClassDeclaration') {
    return isInert(input, module, node);
  }
  if (node.type === 'VariableDeclaration') {
    return (
      node.kind === 'const' &&
      node.declarations.every(
        (declaration) =>
          declaration.init === null || declaration.init === undefined || isInert(input, module, declaration.init),
      )
    );
  }
  return (
    node.type === 'FunctionDeclaration' ||
    node.type === 'TSInterfaceDeclaration' ||
    node.type === 'TSTypeAliasDeclaration'
  );
};

/** A relative specifier that resolves inside the owner and outside its private source roots. */
const isOwnerLocalSpecifier = (
  input: PublishedNativeClientComposition,
  module: SourceModule,
  specifier: string,
): boolean => {
  if (!specifier.startsWith('.')) {
    return false;
  }
  try {
    return input.isOwnerLocalNonPrivate(input.graph.module(path.resolve(path.dirname(module.path), specifier)));
  } catch {
    return false;
  }
};

const isNativeProvider = (specifier: string): boolean =>
  specifier === 'effect' ||
  (specifier.startsWith('effect/') && NATIVE_DATA_NAMESPACES.has(specifier.slice('effect/'.length)));

const isTypeOnlyImport = (statement: ImportDeclaration): boolean =>
  statement.importKind === 'type' ||
  (statement.specifiers.length > 0 &&
    statement.specifiers.every((specifier) => specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'));

const isTypeOnlyReexport = (statement: ExportNamedDeclaration | ExportAllDeclaration): boolean =>
  statement.source === null || statement.source === undefined || statement.exportKind === 'type';

const hasProvenSchemaImport = (
  input: PublishedNativeClientComposition,
  module: SourceModule,
  statement: ImportDeclaration,
): boolean =>
  statement.specifiers.length > 0 &&
  statement.specifiers.every((specifier) => {
    if (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type') {
      return true;
    }
    const binding = input.graph.resolve(module, specifier.local.name, 'local');
    return (
      binding?.kind === 'declaration' &&
      binding.expression.type === 'CallExpression' &&
      input.isNativeSchemaNode?.(binding.module, binding.expression) === true
    );
  });

const statementAllowed = (
  input: PublishedNativeClientComposition,
  module: SourceModule,
  statement: Statement,
): boolean => {
  if (statement.type === 'ImportDeclaration') {
    return (
      isTypeOnlyImport(statement) ||
      isNativeProvider(statement.source.value) ||
      isOwnerLocalSpecifier(input, module, statement.source.value) ||
      hasProvenSchemaImport(input, module, statement)
    );
  }
  if (statement.type === 'ExportAllDeclaration') {
    return isTypeOnlyReexport(statement) || isOwnerLocalSpecifier(input, module, statement.source.value);
  }
  if (statement.type === 'ExportNamedDeclaration') {
    if (statement.source !== null && statement.source !== undefined) {
      return isTypeOnlyReexport(statement) || isOwnerLocalSpecifier(input, module, statement.source.value);
    }
    const { declaration } = statement;
    return declaration === null || declaration === undefined || hasInertDeclaration(input, module, declaration);
  }
  if (
    statement.type === 'VariableDeclaration' ||
    statement.type === 'FunctionDeclaration' ||
    statement.type === 'ClassDeclaration'
  ) {
    return hasInertDeclaration(input, module, statement);
  }
  return (
    statement.type === 'TSInterfaceDeclaration' ||
    statement.type === 'TSModuleDeclaration' ||
    statement.type === 'TSTypeAliasDeclaration'
  );
};

const ownExportedValue = (module: SourceModule, name: string): Node | undefined => {
  for (const statement of module.file.program.body) {
    if (
      statement.type !== 'ExportNamedDeclaration' ||
      statement.declaration?.type !== 'VariableDeclaration' ||
      statement.declaration.kind !== 'const'
    ) {
      continue;
    }
    for (const declaration of statement.declaration.declarations) {
      const identifier = getBindingIdentifiers(declaration.id)[name];
      if (identifier !== undefined && declaration.init !== null && declaration.init !== undefined) {
        return declaration.id.type === 'Identifier' ? declaration.init : identifier;
      }
    }
  }
  return undefined;
};

const isEnrolledImport = (
  input: PublishedNativeClientComposition,
  module: SourceModule,
  statement: ImportDeclaration,
): boolean => {
  const values = statement.specifiers.filter(
    (specifier) => specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type',
  );
  const original = input.graph.module(path.resolve(path.dirname(module.path), statement.source.value));
  return (
    values.length > 0 &&
    values.every((specifier) => {
      const binding = input.graph.resolve(module, specifier.local.name, 'local');
      if (binding?.kind === 'declaration' && input.isEnrolledOperation(binding.module, binding.expression)) {
        return true;
      }
      if (specifier.type !== 'ImportSpecifier') {
        return false;
      }
      const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
      const value = ownExportedValue(original, name);
      return value !== undefined && input.isEnrolledOperation(original, value);
    })
  );
};

const ownerDependencyModules = (
  input: PublishedNativeClientComposition,
  module: SourceModule,
): readonly SourceModule[] =>
  module.file.program.body.flatMap((statement) => {
    if (
      statement.type !== 'ImportDeclaration' &&
      statement.type !== 'ExportNamedDeclaration' &&
      statement.type !== 'ExportAllDeclaration'
    ) {
      return [];
    }
    if (statement.source === null || statement.source === undefined || !statement.source.value.startsWith('.')) {
      return [];
    }
    if (
      statement.type === 'ImportDeclaration'
        ? isTypeOnlyImport(statement) || isEnrolledImport(input, module, statement)
        : isTypeOnlyReexport(statement)
    ) {
      return [];
    }
    return [input.graph.module(path.resolve(path.dirname(module.path), statement.source.value))];
  });

/** Eager/import controls follow every loaded owner dependency, stopping only at enrolled original client leaves. */
const hasModuleControls = (input: PublishedNativeClientComposition, module: SourceModule): boolean => {
  const pending = [module];
  const visited = new Set<string>();
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    if (visited.has(current.path)) {
      continue;
    }
    visited.add(current.path);
    const dependency = current;
    if (
      !input.isOwnerLocalNonPrivate(dependency) ||
      !dependency.file.program.body.every((statement) => statementAllowed(input, dependency, statement))
    ) {
      return false;
    }
    pending.push(...ownerDependencyModules(input, dependency));
  }
  return true;
};

const mutationTarget = (node: Node): Node | undefined => {
  if (node.type === 'AssignmentExpression') {
    return node.left;
  }
  return node.type === 'UpdateExpression' ? node.argument : undefined;
};

/** The root identifier an assignment or update writes through, for example `value` in `value.city = x`. */
const mutatedRoot = (node: Node): Node | undefined => {
  let target = mutationTarget(node);
  while (target !== undefined && target.type === 'MemberExpression') {
    target = target.object;
  }
  return target?.type === 'Identifier' ? target : undefined;
};

const mutationRejected = (input: PublishedNativeClientComposition, module: SourceModule, node: Node): boolean => {
  if (node.type !== 'AssignmentExpression' && node.type !== 'UpdateExpression') {
    return false;
  }
  const receiver = mutatedRoot(node);
  return receiver === undefined || !hasInvocationOwnedData({ graph: input.graph, module }, receiver, node);
};

const MUTATING_DATA_METHODS = new Set([
  'add',
  'clear',
  'delete',
  'fill',
  'pop',
  'push',
  'reverse',
  'set',
  'shift',
  'sort',
  'splice',
  'unshift',
  'copyWithin',
]);

const borrowedMutationCall = (input: PublishedNativeClientComposition, module: SourceModule, node: Node): boolean => {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
    return false;
  }
  const { callee } = node;
  return (
    (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') &&
    !callee.computed &&
    callee.property.type === 'Identifier' &&
    MUTATING_DATA_METHODS.has(callee.property.name) &&
    !nativeDataCall(input.graph, module, callee) &&
    !hasInvocationOwnedData({ graph: input.graph, module }, callee.object, node)
  );
};

const referenceRejected = (graph: ModuleGraph, module: SourceModule, node: Node): boolean => {
  if (node.type !== 'Identifier') {
    return false;
  }
  if (graph.isUnboundReference(module, node)) {
    return node.name !== 'undefined';
  }
  // A rebound or shadowed native namespace is not the original import the graph proved.
  return NATIVE_DATA_NAMESPACES.has(node.name) && graph.resolveReference(module, node)?.kind === 'declaration';
};

const unitValueAllowed = (
  input: PublishedNativeClientComposition,
  value: GraphValue,
  pending: CompositionUnit[],
): boolean => {
  if (value.kind === 'external') {
    return isNativeDataValue(value);
  }
  if (value.kind !== 'node') {
    return true;
  }
  if (input.isEnrolledOperation(value.module, value.node)) {
    return true;
  }
  if (value.node.type === 'CallExpression' && input.isNativeSchemaNode?.(value.module, value.node) === true) {
    return true;
  }
  if (!input.isOwnerLocalNonPrivate(value.module)) {
    return false;
  }
  pending.push({ expression: value.node, module: value.module });
  return true;
};

const callsEnrolledOperation = (input: PublishedNativeClientComposition, module: SourceModule, node: Node): boolean => {
  if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') {
    return false;
  }
  const binding = input.graph.resolveReference(module, node.callee);
  return (
    (binding?.kind === 'declaration' && input.isEnrolledOperation(binding.module, binding.expression)) ||
    input.graph
      .evaluate(module, node.callee)
      .some((value) => value.kind === 'node' && input.isEnrolledOperation(value.module, value.node))
  );
};

/** One unit is authority-free when it only invokes enrolled leaves, native data and local routines. */
const isUnitAuthorityFree = (
  input: PublishedNativeClientComposition,
  unit: CompositionUnit,
  pending: CompositionUnit[],
  invocations: Set<Node>,
): boolean => {
  const { graph } = input;
  const { module } = unit;
  const isPruneRoot = (node: Node): boolean =>
    node.type === 'CallExpression' && input.isNativeSchemaNode?.(module, node) === true;
  let valid = true;
  walk(unit.expression, isPruneRoot, (node) => {
    if (callsEnrolledOperation(input, module, node)) {
      invocations.add(node);
    }
    if (
      mutationRejected(input, module, node) ||
      borrowedMutationCall(input, module, node) ||
      referenceRejected(graph, module, node)
    ) {
      valid = false;
      return;
    }
    if (node.type !== 'Identifier' && node.type !== 'MemberExpression') {
      return;
    }
    if (!graph.evaluate(module, node).every((value) => unitValueAllowed(input, value, pending))) {
      valid = false;
    }
  });
  return valid;
};

/**
 * True when the selected authored export is an authority-free native client composition: it
 * publishes no raw authority, only the enrolled operations and native data APIs it invokes.
 */
export const hasPublishedNativeClientComposition = (input: PublishedNativeClientComposition): boolean => {
  const { graph, selected } = input;
  if (!input.isOwnerLocalNonPrivate(selected.module) || !hasModuleControls(input, selected.module)) {
    return false;
  }
  const generator = isFunction(selected.expression)
    ? selected.expression
    : effectFnGenerator(graph, selected.module, selected.expression);
  if (generator === undefined || !input.hasImmutableCapture(selected.module, selected.expression)) {
    return false;
  }
  const visited = new Set<Node>();
  const pending: CompositionUnit[] = [{ expression: generator, module: selected.module }];
  const invocations = new Set<Node>();
  while (pending.length > 0) {
    const unit = pending.pop();
    if (unit === undefined || visited.has(unit.expression)) {
      continue;
    }
    visited.add(unit.expression);
    if (!isUnitAuthorityFree(input, unit, pending, invocations)) {
      return false;
    }
  }
  return invocations.size > 0;
};
