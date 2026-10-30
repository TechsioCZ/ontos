import type { Context, ESTree, Variable } from '@oxlint/plugins';
import { Predicate } from 'effect';

import { asNode, memberName, nearestFunction, parentOf, skipWrappers, staticString, unwrap, walk } from './ast.ts';
import type { Syntax } from './ast.ts';
import { lookupVariable } from './bindings.ts';
import {
  isNativeDeferredProgram,
  isNativeEffectHelper,
  isNativeEffectValue,
  nativeEffectFunctionBinding,
  nativeClockExecutionOwner,
  nativeEffectIsYieldedInGenerator,
} from './native-live-effect-flow.ts';

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;
type Tester =
  | 'namespace'
  | 'it'
  | 'live'
  | 'registration'
  | 'builder'
  | 'property'
  | 'test'
  | 'testBuilder'
  | 'layerBuilder'
  | 'layerRegistration'
  | 'nativeLayerRegistration'
  | 'nativeLayerIt';
const testRunnerModule = 'effect-rstest';
const transparent = new Set(['ParenthesizedExpression', 'ChainExpression', 'TSNonNullExpression']);
const directMethods = new Set(['only', 'skip', 'fails']);
const builderMethods = new Set(['each', 'runIf', 'skipIf']);
const runnerBuilders = new Set<Tester>(['builder', 'testBuilder', 'layerBuilder']);

const immutableDeclaration = (context: Context, identifier: ESTree.Node): Syntax | null => {
  const variable = lookupVariable(context, identifier);
  if (variable?.defs.length !== 1 || variable.references.some((reference) => reference.isWrite() && !reference.init)) {
    return null;
  }
  const [definition] = variable.defs;
  const declaration = asNode(definition?.node);
  const statement = parentOf(declaration);
  return declaration?.type === 'VariableDeclarator' &&
    statement?.type === 'VariableDeclaration' &&
    statement.kind === 'const'
    ? declaration
    : null;
};

const testerImport = (context: Context, identifier: ESTree.Node): Tester | null => {
  const variable = lookupVariable(context, identifier);
  if (variable?.defs.length !== 1) {
    return null;
  }
  const [definition] = variable.defs;
  const declaration = asNode(definition?.parent);
  const specifier = asNode(definition?.node);
  if (
    definition?.type !== 'ImportBinding' ||
    declaration?.type !== 'ImportDeclaration' ||
    declaration.source.value !== testRunnerModule ||
    declaration.importKind === 'type' ||
    specifier?.importKind === 'type'
  ) {
    return null;
  }
  if (specifier?.type === 'ImportNamespaceSpecifier') {
    return 'namespace';
  }
  if (specifier?.type !== 'ImportSpecifier') {
    return null;
  }
  const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
  return name === 'it' || name === 'live' ? name : null;
};

const typeReference = (node: ESTree.Node): boolean => {
  let ancestor = parentOf(node);
  while (ancestor !== null) {
    if (['TSTypeQuery', 'TSTypeReference', 'TSQualifiedName', 'TSTypeAnnotation'].includes(ancestor.type)) {
      return true;
    }
    if (
      ancestor.type === 'CallExpression' ||
      ancestor.type === 'FunctionDeclaration' ||
      ancestor.type === 'ArrowFunctionExpression'
    ) {
      return false;
    }
    ancestor = parentOf(ancestor);
  }
  return false;
};

const isExported = (node: ESTree.Node): boolean => {
  const parent = parentOf(node);
  return parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration';
};

const nativeNamespace = (binding: Variable, namespace: string): boolean => {
  const definition = binding.defs.length === 1 ? binding.defs[0] : undefined;
  const declaration = asNode(definition?.parent);
  const specifier = asNode(definition?.node);
  if (
    definition?.type !== 'ImportBinding' ||
    declaration?.type !== 'ImportDeclaration' ||
    declaration.importKind === 'type' ||
    specifier?.importKind === 'type'
  ) {
    return false;
  }
  if (specifier?.type === 'ImportNamespaceSpecifier') {
    return declaration.source.value === `effect/${namespace}`;
  }
  if (specifier?.type !== 'ImportSpecifier' || declaration.source.value !== 'effect') {
    return false;
  }
  const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
  return imported === namespace;
};

const namespaceIsStable = (binding: Variable): boolean =>
  binding.references.every((reference) => {
    if (reference.init || typeReference(reference.identifier)) {
      return true;
    }
    let held: ESTree.Node = reference.identifier;
    let parent = parentOf(held);
    if (parent?.type !== 'MemberExpression' || parent.object !== held || parent.computed) {
      return false;
    }
    while (parent?.type === 'MemberExpression' && parent.object === held && !parent.computed) {
      held = parent;
      parent = parentOf(parent);
    }
    return (
      !(parent?.type === 'AssignmentExpression' && parent.left === held) &&
      parent?.type !== 'UpdateExpression' &&
      !(parent?.type === 'UnaryExpression' && parent.operator === 'delete')
    );
  });

const isNativeMemoMapConstructor = (context: Context, input: ESTree.Node | undefined): boolean => {
  const node = unwrap(input);
  if (node?.type !== 'CallExpression' || node.optional || node.arguments.length !== 0) {
    return false;
  }
  const callee = unwrap(node.callee);
  if (
    callee?.type !== 'MemberExpression' ||
    callee.computed ||
    callee.optional ||
    memberName(callee) !== 'makeMemoMapUnsafe' ||
    callee.object.type !== 'Identifier'
  ) {
    return false;
  }
  const binding = lookupVariable(context, callee.object);
  return binding !== null && nativeNamespace(binding, 'Layer') && namespaceIsStable(binding);
};

const literalLayerTimeout = (node: ESTree.Node): boolean => {
  if (node.type !== 'Literal') {
    return false;
  }
  const timeout = node.value;
  return (
    (Predicate.isNumber(timeout) && Number.isFinite(timeout) && timeout > 0) ||
    (Predicate.isString(timeout) && timeout.trim().length > 0)
  );
};

const excludedLayerOptions = (input: ESTree.Node | undefined): { readonly memoMap?: ESTree.Node } | null => {
  const node = unwrap(input);
  if (node?.type !== 'ObjectExpression') {
    return null;
  }
  const seen = new Set<string>();
  let excluded = false;
  let memoMap: ESTree.Node | undefined;
  for (const property of node.properties) {
    if (
      property.type !== 'Property' ||
      property.computed ||
      property.kind !== 'init' ||
      property.key.type !== 'Identifier' ||
      seen.has(property.key.name)
    ) {
      return null;
    }
    seen.add(property.key.name);
    if (property.key.name === 'excludeTestServices') {
      if (property.value.type !== 'Literal' || property.value.value !== true) {
        return null;
      }
      excluded = true;
    } else if (property.key.name === 'memoMap') {
      memoMap = property.value;
    } else if (property.key.name === 'timeout') {
      if (!literalLayerTimeout(property.value)) {
        return null;
      }
    } else {
      return null;
    }
  }
  return excluded ? { memoMap } : null;
};

const nativeMemoMapConsumer = (reference: ESTree.Node, isLayerBuilder: (callee: ESTree.Node) => boolean): boolean => {
  const held = skipWrappers(reference, transparent);
  const property = held.parent;
  const options = parentOf(property);
  const call = parentOf(options);
  return (
    property?.type === 'Property' &&
    property.value === held.node &&
    !property.computed &&
    property.kind === 'init' &&
    property.key.type === 'Identifier' &&
    property.key.name === 'memoMap' &&
    options?.type === 'ObjectExpression' &&
    excludedLayerOptions(options)?.memoMap === held.node &&
    call?.type === 'CallExpression' &&
    !call.optional &&
    call.arguments.length === 2 &&
    call.arguments[0].type !== 'SpreadElement' &&
    call.arguments[1] === options &&
    isLayerBuilder(call.callee)
  );
};

/** The cache is mutable; only its local binding and exclusively native consumers are proven immutable. */
const nativeMemoMap = (
  context: Context,
  input: ESTree.Node,
  isLayerBuilder: (callee: ESTree.Node) => boolean,
): boolean => {
  const node = unwrap(input);
  if (node?.type !== 'Identifier') {
    return false;
  }
  const declaration = immutableDeclaration(context, node);
  const binding = lookupVariable(context, node);
  const statement = declaration === null ? null : parentOf(declaration);
  if (
    declaration === null ||
    binding === null ||
    statement === null ||
    isExported(statement) ||
    !isNativeMemoMapConstructor(context, asNode(declaration.init) ?? undefined)
  ) {
    return false;
  }
  const references = binding.references.filter((reference) => !reference.init && !typeReference(reference.identifier));
  return (
    references.length > 0 &&
    references.every((reference) => nativeMemoMapConsumer(reference.identifier, isLayerBuilder))
  );
};

const excludesTestServices = (
  context: Context,
  input: ESTree.Node | undefined,
  isLayerBuilder: (callee: ESTree.Node) => boolean,
): boolean => {
  const options = excludedLayerOptions(input);
  return options !== null && (options.memoMap === undefined || nativeMemoMap(context, options.memoMap, isLayerBuilder));
};

const layerParameterFunction = (context: Context, identifier: ESTree.Node): FunctionNode | null => {
  const variable = lookupVariable(context, identifier);
  if (variable?.defs.length !== 1) {
    return null;
  }
  const [definition] = variable.defs;
  const fn = asNode(definition.node);
  if (
    definition.type !== 'Parameter' ||
    (fn?.type !== 'ArrowFunctionExpression' && fn?.type !== 'FunctionExpression') ||
    fn.async ||
    fn.generator ||
    fn.params.length !== 1 ||
    fn.params[0].type !== 'Identifier' ||
    lookupVariable(context, fn.params[0]) !== variable
  ) {
    return null;
  }
  if (fn.type === 'FunctionExpression' && fn.id !== null) {
    const named = lookupVariable(context, fn.id);
    if (named !== null && named.references.some((reference) => !typeReference(reference.identifier))) {
      return null;
    }
  }
  return fn;
};

const layerSuiteCall = (fn: FunctionNode): ESTree.CallExpression | null => {
  const held = skipWrappers(fn, transparent);
  const call = held.parent;
  if (
    call?.type !== 'CallExpression' ||
    call.arguments.some((argument: ESTree.Node) => argument.type === 'SpreadElement')
  ) {
    return null;
  }
  const index = call.arguments.length === 1 ? 0 : 1;
  return (call.arguments.length === 1 || call.arguments.length === 2) &&
    call.arguments[index] === held.node &&
    (index === 0 || staticString(call.arguments[0]) !== null)
    ? call
    : null;
};

/** Only the lexical callback parameter of a genuine excluded-services layer is a real-clock runner. */
const nativeLayerOrigin = (
  context: Context,
  identifier: ESTree.Node,
  resolve: (input: ESTree.Node) => Tester | null,
): ESTree.CallExpression | null => {
  const fn = layerParameterFunction(context, identifier);
  const call = fn === null ? null : layerSuiteCall(fn);
  return call !== null && resolve(call.callee) === 'nativeLayerRegistration' ? call : null;
};

const regularTesterMember = (owner: Tester | null, member: string | null): Tester | null => {
  if (owner === 'it' && (member === 'effect' || member === 'scoped')) {
    return 'test';
  }
  if ((owner !== 'it' && owner !== 'test') || member === null) {
    return null;
  }
  if (directMethods.has(member) || member === 'prop') {
    return 'test';
  }
  return builderMethods.has(member) ? 'testBuilder' : null;
};

const testerMember = (owner: Tester | null, member: string | null): Tester | null => {
  if (owner === 'it' && member === 'layer') {
    return 'layerBuilder';
  }
  if (owner === 'nativeLayerIt' && member === 'effect') {
    return 'live';
  }
  if (owner === 'namespace' && member === 'it') {
    return 'it';
  }
  if ((owner === 'it' || owner === 'namespace') && member === 'live') {
    return 'live';
  }
  const regular = regularTesterMember(owner, member);
  if (regular !== null) {
    return regular;
  }
  if (owner !== 'live' || member === null) {
    return null;
  }
  if (directMethods.has(member)) {
    return 'registration';
  }
  if (builderMethods.has(member)) {
    return 'builder';
  }
  return member === 'prop' ? 'property' : null;
};

const tester = (context: Context, expression: ESTree.Node, seen = new Set<ESTree.Node>()): Tester | null => {
  const node = unwrap(expression);
  if (node === null || seen.has(node)) {
    return null;
  }
  seen.add(node);
  if (node.type === 'Identifier') {
    const imported = testerImport(context, node);
    if (imported !== null) {
      return imported;
    }
    if (nativeLayerOrigin(context, node, (callee) => tester(context, callee, seen)) !== null) {
      return 'nativeLayerIt';
    }
    const initial = asNode(immutableDeclaration(context, node)?.init);
    return initial === null ? null : tester(context, initial, seen);
  }
  if (node.type === 'CallExpression') {
    const kind = tester(context, node.callee, seen);
    if (kind === 'layerBuilder') {
      return node.arguments.length === 2 &&
        excludesTestServices(context, node.arguments[1], (callee) => tester(context, callee) === 'layerBuilder')
        ? 'nativeLayerRegistration'
        : 'layerRegistration';
    }
    if (node.arguments.length !== 1) {
      return null;
    }
    if (kind === 'builder') {
      return 'registration';
    }
    return kind === 'testBuilder' ? 'test' : null;
  }
  if (node.type !== 'MemberExpression') {
    return null;
  }
  return testerMember(tester(context, node.object, seen), memberName(node));
};

const liveCallbackArgument = (context: Context, node: ESTree.Node, parent: Syntax | null): boolean => {
  if (
    parent?.type !== 'CallExpression' ||
    parent.arguments.some((argument: ESTree.Node) => argument.type === 'SpreadElement')
  ) {
    return false;
  }
  const kind = tester(context, parent.callee);
  if (kind !== 'live' && kind !== 'registration' && kind !== 'property') {
    return false;
  }
  return parent.arguments[kind === 'property' ? 2 : 1] === node;
};

const functionBinding = (context: Context, fn: FunctionNode): Variable | null => {
  const native = nativeEffectFunctionBinding(context, fn);
  if (native !== null) {
    return native;
  }
  if (fn.type === 'FunctionDeclaration') {
    return fn.id === null || isExported(fn) ? null : lookupVariable(context, fn.id);
  }
  const held = skipWrappers(fn, transparent);
  const declaration = held.parent;
  if (
    declaration?.type !== 'VariableDeclarator' ||
    declaration.init !== held.node ||
    declaration.id.type !== 'Identifier'
  ) {
    return null;
  }
  const immutable = immutableDeclaration(context, declaration.id);
  const statement = parentOf(declaration);
  if (immutable !== declaration || (statement !== null && isExported(statement))) {
    return null;
  }
  if (fn.type === 'FunctionExpression' && fn.id !== null) {
    const named = lookupVariable(context, fn.id);
    if (named !== null && named.references.length > 0) {
      return null;
    }
  }
  return lookupVariable(context, declaration.id);
};

const nativeTesterStability = (context: Context) => {
  let importsStable: boolean | undefined;
  const pending = new Set<Variable>();
  const proven = new Map<Variable, boolean>();
  const proof = {
    bindingIsStable(variable: Variable): boolean {
      const cached = proven.get(variable);
      if (cached !== undefined) {
        return cached;
      }
      if (pending.has(variable) || variable.references.some((reference) => reference.isWrite() && !reference.init)) {
        return false;
      }
      pending.add(variable);
      const stable = variable.references.every(
        (reference) =>
          reference.init || typeReference(reference.identifier) || proof.valueUseIsStable(reference.identifier),
      );
      pending.delete(variable);
      proven.set(variable, stable);
      return stable;
    },

    importsAreStable(): boolean {
      if (importsStable !== undefined) {
        return importsStable;
      }
      let opaqueRunnerImport = false;
      walk(context.sourceCode.ast, context.sourceCode.visitorKeys, (node) => {
        if (
          node.type === 'ImportExpression' &&
          (node.source.type !== 'Literal' || node.source.value === testRunnerModule)
        ) {
          opaqueRunnerImport = true;
        }
        return true;
      });
      if (opaqueRunnerImport) {
        importsStable = false;
        return false;
      }
      const bindings: Variable[] = [];
      for (const statement of context.sourceCode.ast.body) {
        if (statement.type !== 'ImportDeclaration' || statement.source.value !== testRunnerModule) {
          continue;
        }
        for (const specifier of statement.specifiers) {
          if (testerImport(context, specifier.local) === null) {
            continue;
          }
          const variable = lookupVariable(context, specifier.local);
          if (variable !== null) {
            bindings.push(variable);
          }
        }
      }
      importsStable = bindings.every((variable) => proof.bindingIsStable(variable));
      return importsStable;
    },

    originIsStable(input: ESTree.Node, seen = new Set<ESTree.Node>()): boolean {
      if (!proof.importsAreStable()) {
        return false;
      }
      const node = unwrap(input);
      if (node === null || seen.has(node)) {
        return false;
      }
      seen.add(node);
      if (node.type === 'MemberExpression') {
        return proof.originIsStable(node.object, seen);
      }
      if (node.type === 'CallExpression') {
        return proof.originIsStable(node.callee, seen);
      }
      if (node.type !== 'Identifier') {
        return false;
      }
      const variable = lookupVariable(context, node);
      if (variable === null || !proof.bindingIsStable(variable)) {
        return false;
      }
      if (testerImport(context, node) !== null) {
        return true;
      }
      const layer = nativeLayerOrigin(context, node, (callee) => tester(context, callee));
      if (layer !== null) {
        return proof.originIsStable(layer.callee, seen);
      }
      const initializer = asNode(immutableDeclaration(context, node)?.init);
      return initializer !== null && proof.originIsStable(initializer, seen);
    },

    valueUseIsStable(input: ESTree.Node): boolean {
      let held = skipWrappers(input, transparent);
      while (held.parent?.type === 'MemberExpression' && held.parent.object === held.node) {
        if (tester(context, held.parent) === null) {
          return false;
        }
        held = skipWrappers(held.parent, transparent);
      }
      const { node, parent } = held;
      if (parent?.type === 'CallExpression' && parent.callee === node) {
        const kind = tester(context, node);
        if (kind === null || kind === 'namespace') {
          return false;
        }
        return !runnerBuilders.has(kind) || proof.valueUseIsStable(parent);
      }
      if (parent?.type !== 'VariableDeclarator' || parent.init !== node || parent.id.type !== 'Identifier') {
        return false;
      }
      const statement = parentOf(parent);
      const variable = lookupVariable(context, parent.id);
      return (
        immutableDeclaration(context, parent.id) === parent &&
        statement !== null &&
        !isExported(statement) &&
        variable !== null &&
        proof.bindingIsStable(variable)
      );
    },
  };
  return proof;
};

class NativeLiveClockProof {
  readonly #context: Context;
  readonly #tester: ReturnType<typeof nativeTesterStability>;
  readonly #pending = new Set<Variable>();
  readonly #proven = new Map<Variable, boolean>();
  readonly #clockUses = new Map<Variable, boolean>();
  readonly #neutralPending = new Set<ESTree.Node>();

  #neutralLayerUse(input: ESTree.Node, depth = 0): boolean {
    if (depth >= 16) {
      return false;
    }
    const held = skipWrappers(input, transparent);
    const { parent } = held;
    if (parent?.type === 'VariableDeclarator' && parent.init === held.node) {
      return this.#neutralAliasUses(parent, depth);
    }
    if (parent?.type === 'CallExpression' && parent.arguments.some((argument) => argument === held.node)) {
      if (parent.arguments[0] === held.node && tester(this.#context, parent) === 'nativeLayerRegistration') {
        return this.#tester.originIsStable(parent.callee);
      }
      return (
        !parent.arguments.some((argument) => argument.type === 'SpreadElement') &&
        ((this.#layerCombination(parent) && this.#neutralCombinationUse(parent, depth + 1)) ||
          (this.#nativeMember(parent.callee, 'Effect', 'provide') &&
            NativeLiveClockProof.#neutralProvisionOptions(parent)))
      );
    }
    return this.#neutralPipeUse(held.node, parent, depth);
  }

  static #neutralProvisionOptions(call: ESTree.CallExpression): boolean {
    if (call.optional || call.arguments[0]?.type === 'SpreadElement') {
      return false;
    }
    if (call.arguments.length === 1) {
      return true;
    }
    const [, options] = call.arguments;
    if (call.arguments.length !== 2 || options?.type !== 'ObjectExpression' || options.properties.length !== 1) {
      return false;
    }
    const [property] = options.properties;
    return (
      property?.type === 'Property' &&
      !property.computed &&
      property.kind === 'init' &&
      property.key.type === 'Identifier' &&
      property.key.name === 'local' &&
      property.value.type === 'Literal' &&
      property.value.value === true
    );
  }

  #neutralPipeUse(node: ESTree.Node, parent: Syntax | null, depth: number): boolean {
    if (
      parent?.type !== 'MemberExpression' ||
      parent.object !== node ||
      parent.computed ||
      parent.optional ||
      memberName(parent) !== 'pipe'
    ) {
      return false;
    }
    const call = parentOf(parent);
    return (
      call?.type === 'CallExpression' &&
      call.callee === parent &&
      call.arguments.length > 0 &&
      call.arguments.every((argument) => this.#neutralTransform(argument, depth)) &&
      this.#neutralLayerUse(call, depth + 1)
    );
  }

  #neutralAliasUses(declaration: ESTree.VariableDeclarator, depth: number): boolean {
    if (declaration.id.type !== 'Identifier') {
      return false;
    }
    const statement = parentOf(declaration);
    const binding = lookupVariable(this.#context, declaration.id);
    return (
      immutableDeclaration(this.#context, declaration.id) === declaration &&
      statement !== null &&
      !isExported(statement) &&
      binding !== null &&
      binding.references.every(
        (reference) =>
          reference.init ||
          typeReference(reference.identifier) ||
          this.#neutralLayerUse(reference.identifier, depth + 1),
      )
    );
  }

  #neutralTransform(input: ESTree.Node, depth: number): boolean {
    return (
      input.type === 'CallExpression' &&
      this.#layerCombination(input) &&
      input.arguments.every(
        (dependency) => dependency.type !== 'SpreadElement' && this.#neutralLayer(dependency, depth + 1),
      )
    );
  }

  #neutralCombinationUse(call: ESTree.CallExpression, depth: number): boolean {
    const parent = parentOf(call);
    if (parent?.type === 'CallExpression' && parent.arguments.some((argument) => argument === call)) {
      const callee = unwrap(parent.callee);
      return (
        callee?.type === 'MemberExpression' &&
        !callee.computed &&
        !callee.optional &&
        memberName(callee) === 'pipe' &&
        (this.#layerConsumedLive(parent) || this.#neutralLayerUse(parent, depth + 1))
      );
    }
    return this.#neutralLayerUse(call, depth + 1);
  }

  #layerCombination(call: ESTree.CallExpression): boolean {
    const callee = unwrap(call.callee);
    if (call.optional || callee?.type !== 'MemberExpression' || callee.computed || callee.optional) {
      return false;
    }

    return this.#nativeMember(call.callee, 'Layer', 'provide') ||
      this.#nativeMember(call.callee, 'Layer', 'provideMerge')
      ? call.arguments.length === 1 || call.arguments.length === 2
      : (this.#nativeMember(call.callee, 'Layer', 'merge') && call.arguments.length === 2) ||
          (this.#nativeMember(call.callee, 'Layer', 'mergeAll') && call.arguments.length > 0);
  }

  #neutralLayerLeaf(node: ESTree.MemberExpression): boolean {
    if (node.computed || node.optional || memberName(node) !== 'layer' || node.object.type !== 'Identifier') {
      return false;
    }
    const binding = lookupVariable(this.#context, node.object);
    return binding !== null && NativeLiveClockProof.#neutralLeafImport(binding) && this.#neutralLeafUses(binding);
  }

  static #neutralLeafImport(binding: Variable): boolean {
    const definition = binding?.defs.length === 1 ? binding.defs[0] : undefined;
    const declaration = asNode(definition?.parent);
    const specifier = asNode(definition?.node);
    if (
      definition?.type !== 'ImportBinding' ||
      declaration?.type !== 'ImportDeclaration' ||
      declaration.importKind === 'type' ||
      specifier?.type !== 'ImportSpecifier' ||
      specifier.importKind === 'type'
    ) {
      return false;
    }
    const imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value;
    const nativeOutput =
      declaration.source.value === '@effect/platform-node' &&
      ['NodeChildProcessSpawner', 'NodeServices', 'NodeCrypto'].includes(imported);
    if (!nativeOutput && !(declaration.source.value === 'effect/http' && imported === 'FetchHttpClient')) {
      return false;
    }
    return true;
  }

  #neutralLeafUses(binding: Variable): boolean {
    return binding.references.every((reference) => {
      if (typeReference(reference.identifier)) {
        return true;
      }
      const access = parentOf(reference.identifier);
      return (
        access?.type === 'MemberExpression' &&
        access.object === reference.identifier &&
        !access.computed &&
        !access.optional &&
        memberName(access) === 'layer' &&
        this.#neutralLayerUse(access)
      );
    });
  }

  #nonClockService(input: ESTree.Node): boolean {
    const node = unwrap(input);
    if (node?.type !== 'Identifier') {
      return false;
    }
    const declaration = immutableDeclaration(this.#context, node);
    const binding = lookupVariable(this.#context, node);
    const statement = declaration === null ? null : parentOf(declaration);
    const initial = unwrap(declaration?.init);
    if (
      binding === null ||
      statement === null ||
      isExported(statement) ||
      initial?.type !== 'CallExpression' ||
      initial.optional ||
      initial.arguments.length !== 1 ||
      !this.#nativeMember(initial.callee, 'Context', 'Service')
    ) {
      return false;
    }
    // Installed Effect's ClockRef is keyed by "effect/Clock". A different literal
    // Context.Service key cannot replace it; dynamic keys and aliases remain unknown.
    const key = staticString(initial.arguments[0]);
    return key !== null && key !== 'effect/Clock' && this.#serviceUsesAreSafe(binding);
  }

  #serviceUsesAreSafe(binding: Variable): boolean {
    return binding.references.every((reference) => {
      if (reference.init || typeReference(reference.identifier)) {
        return true;
      }
      const held = skipWrappers(reference.identifier, transparent);
      const { parent } = held;
      if (parent?.type === 'YieldExpression' && parent.delegate && parent.argument === held.node) {
        return true;
      }
      return (
        parent?.type === 'CallExpression' &&
        !parent.optional &&
        parent.arguments.length === 2 &&
        parent.arguments[0] === held.node &&
        this.#nativeMember(parent.callee, 'Layer', 'effect')
      );
    });
  }

  #neutralLayer(input: ESTree.Node, depth = 0): boolean {
    if (this.#neutralPending.has(input)) {
      return false;
    }
    this.#neutralPending.add(input);
    try {
      return this.#neutralLayerValue(input, depth);
    } finally {
      this.#neutralPending.delete(input);
    }
  }

  #neutralLayerValue(input: ESTree.Node, depth: number): boolean {
    if (depth >= 16) {
      return false;
    }
    const node = unwrap(input);
    if (node?.type === 'Identifier') {
      const declaration = immutableDeclaration(this.#context, node);
      return (
        declaration?.type === 'VariableDeclarator' &&
        declaration.init !== null &&
        this.#neutralLayerUse(node) &&
        this.#neutralLayer(declaration.init, depth + 1)
      );
    }
    if (node?.type === 'MemberExpression') {
      return this.#neutralLayerLeaf(node);
    }
    if (node?.type !== 'CallExpression' || node.arguments.some((argument) => argument.type === 'SpreadElement')) {
      return false;
    }
    if (this.#layerCombination(node)) {
      return node.arguments.every((argument) => this.#neutralLayer(argument, depth + 1));
    }
    if (this.#nativeMember(node.callee, 'Layer', 'effect') && node.arguments.length === 2) {
      return !node.optional && this.#nonClockService(node.arguments[0]);
    }
    return this.#neutralLayerPipe(node, depth);
  }

  #neutralLayerPipe(node: ESTree.CallExpression, depth: number): boolean {
    const callee = unwrap(node.callee);
    return (
      callee?.type === 'MemberExpression' &&
      !callee.computed &&
      !callee.optional &&
      memberName(callee) === 'pipe' &&
      this.#neutralLayer(callee.object, depth + 1) &&
      node.arguments.length > 0 &&
      node.arguments.every((argument) => this.#neutralTransform(argument, depth))
    );
  }

  #layerAliasConsumedLive(declaration: ESTree.VariableDeclarator, active: Set<Variable>, explicit = false): boolean {
    if (declaration.id.type !== 'Identifier') {
      return false;
    }
    const statement = parentOf(declaration);
    const binding = lookupVariable(this.#context, declaration.id);
    if (
      immutableDeclaration(this.#context, declaration.id) !== declaration ||
      statement === null ||
      isExported(statement) ||
      binding === null ||
      active.has(binding) ||
      active.size >= 16
    ) {
      return false;
    }
    const references = binding.references.filter(
      (reference) => !reference.init && !typeReference(reference.identifier),
    );
    const nested = new Set([...active, binding]);
    return (
      references.length > 0 &&
      references.every((reference) => this.#layerConsumedLive(reference.identifier, nested, explicit))
    );
  }

  #layerPipeConsumedLive(node: ESTree.Node, parent: Syntax | null, active: Set<Variable>, explicit = false): boolean {
    if (
      parent?.type !== 'MemberExpression' ||
      parent.object !== node ||
      parent.computed ||
      parent.optional ||
      memberName(parent) !== 'pipe'
    ) {
      return false;
    }
    const call = parentOf(parent);
    return (
      call?.type === 'CallExpression' &&
      call.callee === parent &&
      call.arguments.length > 0 &&
      call.arguments.every(
        (argument) =>
          argument.type === 'CallExpression' &&
          (!explicit || this.#explicitLayerRecipe(argument)) &&
          (this.#nativeMember(argument.callee, 'Layer', 'provide') ||
            this.#nativeMember(argument.callee, 'Layer', 'provideMerge')) &&
          argument.arguments.length === 1 &&
          argument.arguments[0].type !== 'SpreadElement' &&
          (explicit || this.#neutralLayer(argument.arguments[0])),
      ) &&
      this.#layerConsumedLive(call, active, explicit)
    );
  }

  static #layerFactoryParametersAreSafe(fn: ESTree.ArrowFunctionExpression): boolean {
    return fn.params.every(
      (parameter) =>
        parameter.type === 'Identifier' ||
        (parameter.type === 'AssignmentPattern' &&
          parameter.left.type === 'Identifier' &&
          parameter.right.type === 'Literal'),
    );
  }

  #layerFactoryConsumedLive(fn: ESTree.ArrowFunctionExpression, active: Set<Variable>, explicit: boolean): boolean {
    if (
      fn.async ||
      fn.generator ||
      fn.body.type === 'BlockStatement' ||
      !NativeLiveClockProof.#layerFactoryParametersAreSafe(fn)
    ) {
      return false;
    }
    const held = skipWrappers(fn, transparent);
    const declaration = held.parent;
    if (
      declaration?.type !== 'VariableDeclarator' ||
      declaration.init !== held.node ||
      declaration.id.type !== 'Identifier'
    ) {
      return false;
    }
    const binding = lookupVariable(this.#context, declaration.id);
    const statement = parentOf(declaration);
    if (
      immutableDeclaration(this.#context, declaration.id) !== declaration ||
      binding === null ||
      statement === null ||
      isExported(statement) ||
      active.has(binding) ||
      active.size >= 16
    ) {
      return false;
    }
    const references = binding.references.filter(
      (reference) => !reference.init && !typeReference(reference.identifier),
    );
    const nested = new Set([...active, binding]);
    return (
      references.length > 0 &&
      references.every((reference) => this.#layerFactoryCallIsLive(reference.identifier, nested, explicit))
    );
  }

  #layerFactoryCallIsLive(input: ESTree.Node, active: Set<Variable>, explicit: boolean): boolean {
    const held = skipWrappers(input, transparent);
    const call = held.parent;
    return (
      call?.type === 'CallExpression' &&
      !call.optional &&
      call.callee === held.node &&
      !call.arguments.some((argument) => argument.type === 'SpreadElement') &&
      this.#layerConsumedLive(call, active, explicit)
    );
  }

  #layerConsumedLive(input: ESTree.Node, active = new Set<Variable>(), explicit = false): boolean {
    const held = skipWrappers(input, transparent);
    const { parent } = held;
    if (parent?.type === 'VariableDeclarator' && parent.init === held.node) {
      return this.#layerAliasConsumedLive(parent, active, explicit);
    }
    if (parent?.type === 'ArrowFunctionExpression' && parent.body === held.node) {
      return this.#layerFactoryConsumedLive(parent, active, explicit);
    }
    if (
      parent?.type === 'CallExpression' &&
      parent.arguments[0] === held.node &&
      parent.arguments.length === 2 &&
      tester(this.#context, parent) === 'nativeLayerRegistration'
    ) {
      return this.#tester.originIsStable(parent.callee);
    }
    return (
      this.#layerPipeConsumedLive(held.node, parent, active, explicit) ||
      (explicit && this.#explicitLayerDependency(held.node, parent, active))
    );
  }

  #explicitLayerRecipe(input: ESTree.Node): boolean {
    return (
      input.type === 'CallExpression' &&
      !input.optional &&
      input.arguments.length === 1 &&
      input.arguments[0].type !== 'SpreadElement' &&
      (this.#nativeMember(input.callee, 'Layer', 'provide') ||
        this.#nativeMember(input.callee, 'Layer', 'provideMerge'))
    );
  }

  #explicitLayerValue(input: ESTree.Node, active = new Set<Variable>()): boolean {
    const node = unwrap(input);
    if (node?.type === 'Identifier') {
      return this.#explicitLayerAlias(node, active);
    }
    if (
      node?.type !== 'CallExpression' ||
      node.optional ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return false;
    }
    if (
      (this.#nativeMember(node.callee, 'Layer', 'effect') || this.#nativeMember(node.callee, 'Layer', 'merge')) &&
      node.arguments.length === 2
    ) {
      return true;
    }
    if (this.#nativeMember(node.callee, 'Layer', 'mergeAll') && node.arguments.length > 0) {
      return true;
    }
    const callee = unwrap(node.callee);
    return (
      callee?.type === 'MemberExpression' &&
      !callee.computed &&
      !callee.optional &&
      memberName(callee) === 'pipe' &&
      this.#explicitLayerValue(callee.object, active) &&
      node.arguments.every((argument) => this.#explicitLayerRecipe(argument))
    );
  }

  #explicitLayerAlias(node: ESTree.Node, active: Set<Variable>): boolean {
    const binding = lookupVariable(this.#context, node);
    const declaration = immutableDeclaration(this.#context, node);
    return (
      binding !== null &&
      !active.has(binding) &&
      active.size < 16 &&
      declaration?.type === 'VariableDeclarator' &&
      declaration.init !== null &&
      this.#explicitLayerValue(declaration.init, new Set([...active, binding])) &&
      this.#layerAliasConsumedLive(declaration, active, true)
    );
  }

  #explicitLayerDependency(node: ESTree.Node, parent: Syntax | null, active: Set<Variable>): boolean {
    if (parent?.type !== 'CallExpression' || parent.arguments[0] !== node || !this.#explicitLayerRecipe(parent)) {
      return false;
    }
    const pipe = parentOf(parent);
    const callee = pipe?.type === 'CallExpression' ? unwrap(pipe.callee) : null;
    return (
      pipe?.type === 'CallExpression' &&
      pipe.arguments.some((argument) => argument === parent) &&
      callee?.type === 'MemberExpression' &&
      !callee.computed &&
      !callee.optional &&
      memberName(callee) === 'pipe' &&
      this.#explicitLayerValue(callee.object) &&
      pipe.arguments.every((argument) => this.#explicitLayerRecipe(argument)) &&
      this.#layerConsumedLive(pipe, active, true)
    );
  }

  #layerSetupIsLive(node: ESTree.Node): boolean {
    const generator = this.#nativeGeneratorCall(node);
    if (generator === null) {
      return false;
    }
    const held = skipWrappers(generator, transparent);
    const call = held.parent;
    return (
      call?.type === 'CallExpression' &&
      call.arguments.length === 2 &&
      call.arguments[1] === held.node &&
      !call.arguments.some((argument) => argument.type === 'SpreadElement') &&
      this.#nativeMember(call.callee, 'Layer', 'effect') &&
      this.#layerConsumedLive(call)
    );
  }

  #nativeMember(input: ESTree.Node, namespace: string, member: string): boolean {
    const node = unwrap(input);
    if (node?.type !== 'MemberExpression' || memberName(node) !== member || node.object.type !== 'Identifier') {
      return false;
    }
    const binding = lookupVariable(this.#context, node.object);
    return binding !== null && nativeNamespace(binding, namespace) && namespaceIsStable(binding);
  }

  static #clockObservationIsSafe(node: ESTree.Node, parent: Syntax | null): boolean {
    if (
      parent?.type === 'MemberExpression' &&
      parent.object === node &&
      !parent.computed &&
      !parent.optional &&
      (memberName(parent) === 'currentTimeMillis' || memberName(parent) === 'currentTimeNanos')
    ) {
      const observation = skipWrappers(parent, transparent);
      return (
        observation.parent?.type === 'YieldExpression' &&
        observation.parent.delegate &&
        observation.parent.argument === observation.node
      );
    }
    return false;
  }

  static #clockSleepIsSafe(node: ESTree.Node, parent: Syntax | null): boolean {
    if (
      parent?.type !== 'MemberExpression' ||
      parent.object !== node ||
      parent.computed ||
      parent.optional ||
      memberName(parent) !== 'sleep'
    ) {
      return false;
    }
    const call = parentOf(parent);
    const consumer = call === null ? null : skipWrappers(call, transparent);
    return (
      call?.type === 'CallExpression' &&
      call.callee === parent &&
      !call.optional &&
      call.arguments.length === 1 &&
      call.arguments[0].type !== 'SpreadElement' &&
      consumer?.parent?.type === 'YieldExpression' &&
      consumer.parent.delegate &&
      consumer.parent.argument === consumer.node
    );
  }

  #canonicalHelperCall(input: ESTree.Node): boolean {
    const node = unwrap(input);
    if (
      node?.type !== 'CallExpression' ||
      node.optional ||
      node.callee.type !== 'Identifier' ||
      node.arguments.some((argument) => argument.type === 'SpreadElement')
    ) {
      return false;
    }
    const binding = lookupVariable(this.#context, node.callee);
    const declaration = immutableDeclaration(this.#context, node.callee);
    const statement = declaration === null ? null : parentOf(declaration);
    const factory = unwrap(declaration?.init);
    const fn =
      factory?.type === 'CallExpression' && factory.arguments.length === 1 ? unwrap(factory.arguments[0]) : null;
    return (
      binding !== null &&
      statement !== null &&
      !isExported(statement) &&
      fn !== null &&
      nativeEffectFunctionBinding(this.#context, fn) === binding
    );
  }

  #clockUseIsSafe(identifier: Variable['references'][number]['identifier'], active: Set<Variable>): boolean {
    const held = skipWrappers(identifier, transparent);
    const { parent } = held;
    if (NativeLiveClockProof.#clockSleepIsSafe(held.node, parent)) {
      return true;
    }
    if (NativeLiveClockProof.#clockObservationIsSafe(held.node, parent)) {
      return true;
    }
    if (parent?.type === 'VariableDeclarator' && parent.init === held.node && parent.id.type === 'Identifier') {
      const alias = lookupVariable(this.#context, parent.id);
      return (
        immutableDeclaration(this.#context, parent.id) === parent &&
        alias !== null &&
        this.#clockUsesAreSafe(alias, active)
      );
    }
    if (
      parent?.type !== 'CallExpression' ||
      parent.arguments.some((argument: ESTree.Node) => argument.type === 'SpreadElement')
    ) {
      return false;
    }
    if (this.#nativeMember(parent.callee, 'Effect', 'provideService')) {
      return (
        parent.arguments.length === 2 &&
        parent.arguments[1] === held.node &&
        this.#nativeMember(parent.arguments[0], 'Clock', 'Clock')
      );
    }
    return this.#clockForwardedParameter(parent, identifier, active);
  }

  #clockForwardedParameter(
    parent: ESTree.CallExpression,
    identifier: Variable['references'][number]['identifier'],
    active: Set<Variable>,
  ): boolean {
    const callee = unwrap(parent.callee);
    if (callee?.type !== 'Identifier') {
      return false;
    }
    const binding = lookupVariable(this.#context, callee);
    const declaration = immutableDeclaration(this.#context, callee);
    const initializer = unwrap(declaration?.init);
    const fn =
      initializer?.type === 'CallExpression' && initializer.arguments.length === 1
        ? unwrap(initializer.arguments[0])
        : initializer;
    if (
      binding === null ||
      fn === null ||
      (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') ||
      !(
        (fn.type === 'ArrowFunctionExpression' && !fn.async && !fn.generator) ||
        nativeEffectFunctionBinding(this.#context, fn) === binding
      )
    ) {
      return false;
    }
    const index = parent.arguments.findIndex((argument) => unwrap(argument) === identifier);
    const parameter = fn.params[index];
    if (parameter?.type !== 'Identifier') {
      return false;
    }
    const target = lookupVariable(this.#context, parameter);
    return target !== null && this.#clockUsesAreSafe(target, active);
  }

  #clockUsesAreSafe(binding: Variable, active = new Set<Variable>()): boolean {
    const cached = this.#clockUses.get(binding);
    if (cached !== undefined) {
      return cached;
    }
    if (
      active.has(binding) ||
      active.size >= 16 ||
      binding.defs.length !== 1 ||
      binding.references.some((reference) => reference.isWrite() && !reference.init)
    ) {
      return false;
    }
    const nested = new Set([...active, binding]);
    const uses = binding.references.filter((reference) => !reference.init && !typeReference(reference.identifier));
    const safe = uses.length > 0 && uses.every((reference) => this.#clockUseIsSafe(reference.identifier, nested));
    this.#clockUses.set(binding, safe);
    return safe;
  }

  #clockOrigin(input: ESTree.Node, active = new Set<Variable>()): boolean {
    const node = unwrap(input);
    if (this.#defaultClockFactory(node)) {
      return node !== null && this.#defaultClockNativeUse(node, active);
    }
    if (node?.type !== 'Identifier') {
      return false;
    }
    const binding = lookupVariable(this.#context, node);
    if (binding === null || active.has(binding) || active.size >= 16 || !this.#clockUsesAreSafe(binding)) {
      return false;
    }
    const nested = new Set([...active, binding]);
    const declaration = immutableDeclaration(this.#context, node);
    const initial = unwrap(declaration?.init);
    if (this.#defaultClockFactory(initial)) {
      return this.#defaultClockBindingIsNative(binding, declaration);
    }
    if (initial?.type === 'Identifier') {
      return this.#clockOrigin(initial, nested);
    }
    if (initial?.type === 'YieldExpression') {
      return this.#capturedClockOrigin(initial);
    }
    return this.#clockParameterOrigin(binding, nested);
  }

  #capturedClockOrigin(initial: ESTree.YieldExpression): boolean {
    return (
      initial.delegate &&
      initial.argument !== null &&
      this.#nativeMember(initial.argument, 'Clock', 'Clock') &&
      (this.#liveGeneratorCall(initial) !== null ||
        this.#ownerIsLive(nearestFunction(initial)) ||
        this.#layerClockOrigin(initial))
    );
  }

  #layerClockOrigin(input: ESTree.Node): boolean {
    const key = input.type === 'YieldExpression' ? input.argument : null;
    if (key === null || !this.#clockKeyUsesAreSafe(key)) {
      return false;
    }
    const generator = this.#nativeGeneratorCall(input);
    const held = generator === null ? null : skipWrappers(generator, transparent);
    const layer = held?.parent;
    return (
      layer?.type === 'CallExpression' &&
      !layer.optional &&
      layer.arguments.length === 2 &&
      layer.arguments[1] === held?.node &&
      this.#nativeMember(layer.callee, 'Layer', 'effect') &&
      this.#nonClockService(layer.arguments[0]) &&
      this.#layerConsumedLive(layer)
    );
  }

  #defaultClockBindingIsNative(binding: Variable, declaration: ESTree.Node | null): boolean {
    const statement = declaration === null ? null : parentOf(declaration);
    return statement !== null && !isExported(statement) && this.#defaultClockUsesNative(binding);
  }

  #clockParameterOrigin(binding: Variable, nested: Set<Variable>): boolean {
    const [definition] = binding.defs;
    const fn = asNode(definition?.node);
    if (
      definition?.type !== 'Parameter' ||
      fn === null ||
      (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')
    ) {
      return false;
    }
    const nativeBinding = nativeEffectFunctionBinding(this.#context, fn);
    if (!((fn.type === 'ArrowFunctionExpression' && !fn.async && !fn.generator) || nativeBinding !== null)) {
      return false;
    }
    const index = fn.params.findIndex(
      (parameter: ESTree.Node) =>
        parameter.type === 'Identifier' && lookupVariable(this.#context, parameter) === binding,
    );
    const owner = nativeBinding ?? functionBinding(this.#context, fn);
    if (index === -1 || owner === null) {
      return false;
    }
    const calls = owner.references.filter((reference) => !reference.init && !typeReference(reference.identifier));
    return (
      calls.length > 0 &&
      calls.every((reference) => {
        const held = skipWrappers(reference.identifier, transparent);
        const call = held.parent;
        return (
          call?.type === 'CallExpression' &&
          call.callee === held.node &&
          !call.arguments.some((argument: ESTree.Node) => argument.type === 'SpreadElement') &&
          call.arguments[index] !== undefined &&
          this.#clockOrigin(call.arguments[index], nested)
        );
      })
    );
  }

  #nativeGeneratorCall(node: ESTree.Node): ESTree.CallExpression | null {
    const fn = nearestFunction(node);
    const held = fn === null ? null : skipWrappers(fn, transparent);
    const gen = held?.parent;
    if (
      fn?.type !== 'FunctionExpression' ||
      !fn.generator ||
      fn.async ||
      gen?.type !== 'CallExpression' ||
      gen.arguments.length !== 1 ||
      gen.arguments[0] !== held?.node ||
      !this.#nativeMember(gen.callee, 'Effect', 'gen')
    ) {
      return null;
    }
    if (fn.id !== null) {
      const named = lookupVariable(this.#context, fn.id);
      if (named === null || named.references.some((reference) => !typeReference(reference.identifier))) {
        return null;
      }
    }
    return gen;
  }

  #liveGeneratorCall(node: ESTree.Node): ESTree.CallExpression | null {
    const call = this.#nativeGeneratorCall(node);
    return call !== null && this.#ownerIsLive(nativeClockExecutionOwner(this.#context, call)) ? call : null;
  }

  #providedClock(node: ESTree.Node): boolean {
    if (!isNativeEffectValue(this.#context, node)) {
      return this.#providedTimer(node);
    }
    const heldSite = skipWrappers(node, transparent);
    if (
      heldSite.parent?.type !== 'YieldExpression' ||
      !heldSite.parent.delegate ||
      heldSite.parent.argument !== heldSite.node
    ) {
      return false;
    }
    const gen = this.#nativeGeneratorCall(node);
    if (gen === null) {
      return false;
    }
    const receiver = skipWrappers(gen, transparent);
    const pipe = receiver.parent;
    const call = pipe === null ? null : parentOf(pipe);
    if (
      pipe?.type !== 'MemberExpression' ||
      pipe.object !== receiver.node ||
      memberName(pipe) !== 'pipe' ||
      call?.type !== 'CallExpression' ||
      call.callee !== pipe
    ) {
      return false;
    }
    return this.#clockTransforms(call.arguments);
  }

  #providedSleep(node: ESTree.Node): boolean {
    const held = skipWrappers(node, transparent);
    const call = held.parent;
    if (
      node.type === 'MemberExpression' &&
      !node.computed &&
      !node.optional &&
      this.#nativeMember(node, 'Effect', 'sleep') &&
      call?.type === 'CallExpression' &&
      !call.optional &&
      call.callee === held.node &&
      call.arguments.length === 1 &&
      call.arguments[0]?.type !== 'SpreadElement'
    ) {
      const receiver = skipWrappers(call, transparent);
      const pipeline = parentOf(receiver.parent);
      return (
        pipeline !== null &&
        this.#effectHasLiveClock(call) &&
        this.#ownerIsLive(nativeClockExecutionOwner(this.#context, pipeline))
      );
    }
    return false;
  }

  #providedTimer(node: ESTree.Node): boolean {
    if (this.#providedSleep(node)) {
      return true;
    }
    const held = skipWrappers(node, transparent);
    const call = held.parent;
    const gen = this.#nativeGeneratorCall(node);
    if (
      node.type !== 'MemberExpression' ||
      node.computed ||
      node.optional ||
      !this.#nativeMember(node, 'Effect', 'timeoutOrElse') ||
      call?.type !== 'CallExpression' ||
      call.optional ||
      call.callee !== held.node ||
      gen === null ||
      !nativeEffectIsYieldedInGenerator(this.#context, call, gen.arguments[0])
    ) {
      return false;
    }
    return this.#effectHasLiveClock(gen);
  }

  #effectHasLiveClock(gen: ESTree.Node): boolean {
    const receiver = skipWrappers(gen, transparent);
    const pipe = receiver.parent;
    const outer = pipe === null ? null : parentOf(pipe);
    return (
      pipe?.type === 'MemberExpression' &&
      !pipe.computed &&
      !pipe.optional &&
      pipe.object === receiver.node &&
      memberName(pipe) === 'pipe' &&
      outer?.type === 'CallExpression' &&
      !outer.optional &&
      outer.callee === pipe &&
      this.#clockTransforms(outer.arguments)
    );
  }

  #providedHelperInvocation(call: ESTree.CallExpression): boolean {
    return this.#canonicalHelperCall(call) && this.#effectHasLiveClock(call);
  }

  #providedGeneratorCall(call: ESTree.CallExpression): boolean {
    const gen = this.#nativeGeneratorCall(call);
    return (
      this.#canonicalHelperCall(call) &&
      gen !== null &&
      nativeEffectIsYieldedInGenerator(this.#context, call, gen.arguments[0]) &&
      this.#effectHasLiveClock(gen)
    );
  }

  #defaultClockUsesNative(binding: Variable, active = new Set<Variable>()): boolean {
    if (active.has(binding) || active.size >= 16) {
      return false;
    }
    const nested = new Set([...active, binding]);
    return binding.references.every(
      (reference) =>
        reference.init ||
        typeReference(reference.identifier) ||
        this.#defaultClockNativeUse(reference.identifier, nested),
    );
  }

  #defaultClockNativeUse(identifier: ESTree.Node, nested: Set<Variable>): boolean {
    const held = skipWrappers(identifier, transparent);
    const { parent } = held;
    if (parent?.type === 'VariableDeclarator' && parent.init === held.node && parent.id.type === 'Identifier') {
      const alias = lookupVariable(this.#context, parent.id);
      const statement = parentOf(parent);
      return (
        immutableDeclaration(this.#context, parent.id) === parent &&
        statement !== null &&
        !isExported(statement) &&
        alias !== null &&
        this.#defaultClockUsesNative(alias, nested)
      );
    }
    if (
      parent?.type !== 'CallExpression' ||
      parent.optional ||
      !this.#nativeMember(parent.callee, 'Effect', 'provideService') ||
      parent.arguments.length !== 2 ||
      parent.arguments[1] !== held.node
    ) {
      return false;
    }
    return this.#defaultClockProviderBoundary(parent);
  }

  #defaultClockProviderBoundary(parent: ESTree.CallExpression): boolean {
    const pipeline = parentOf(parent);
    const callee = pipeline?.type === 'CallExpression' ? unwrap(pipeline.callee) : null;
    return (
      pipeline?.type === 'CallExpression' &&
      !pipeline.optional &&
      pipeline.arguments.some((argument) => argument === parent) &&
      callee?.type === 'MemberExpression' &&
      !callee.computed &&
      !callee.optional &&
      memberName(callee) === 'pipe' &&
      this.#explicitEffectBoundary(pipeline)
    );
  }

  #explicitEffectBoundary(input: ESTree.Node): boolean {
    const held = skipWrappers(input, transparent);
    const call = held.parent;
    if (
      call?.type === 'CallExpression' &&
      call.arguments.length === 2 &&
      call.arguments[1] === held.node &&
      this.#nativeMember(call.callee, 'Layer', 'effect')
    ) {
      return this.#layerConsumedLive(call, new Set(), true);
    }
    return this.#ownerIsLive(nativeClockExecutionOwner(this.#context, input));
  }

  #defaultClockFactory(input: ESTree.Node | null): boolean {
    if (input?.type !== 'CallExpression' || input.optional || input.arguments.length !== 0) {
      return false;
    }
    const factory = unwrap(input.callee);
    if (
      factory?.type !== 'MemberExpression' ||
      factory.computed ||
      factory.optional ||
      memberName(factory) !== 'defaultValue' ||
      !this.#nativeMember(factory.object, 'Clock', 'Clock')
    ) {
      return false;
    }
    return this.#clockKeyUsesAreSafe(factory.object);
  }

  #clockKeyUsesAreSafe(input: ESTree.Node): boolean {
    const key = unwrap(input);
    if (key?.type !== 'MemberExpression' || key.computed || key.optional) {
      return false;
    }
    const binding = lookupVariable(this.#context, key.object);
    return (
      binding !== null &&
      binding.references.every((reference) => {
        if (typeReference(reference.identifier)) {
          return true;
        }
        const access = parentOf(reference.identifier);
        return (
          access?.type === 'MemberExpression' &&
          (memberName(access) !== 'Clock' || this.#clockServiceKeyUseIsSafe(access))
        );
      })
    );
  }

  #clockServiceKeyUseIsSafe(key: ESTree.Node): boolean {
    const { node, parent } = skipWrappers(key, transparent);
    if (parent?.type === 'YieldExpression' && parent.delegate && parent.argument === node) {
      return true;
    }
    if (parent?.type === 'CallExpression') {
      return (
        parent.arguments.length === 2 &&
        parent.arguments[0] === node &&
        this.#nativeMember(parent.callee, 'Effect', 'provideService')
      );
    }
    if (
      parent?.type !== 'MemberExpression' ||
      parent.object !== node ||
      parent.computed ||
      parent.optional ||
      memberName(parent) !== 'defaultValue'
    ) {
      return false;
    }
    const call = parentOf(parent);
    return call?.type === 'CallExpression' && !call.optional && call.callee === parent && call.arguments.length === 0;
  }

  #clockTransforms(argumentsList: readonly ESTree.Node[]): boolean {
    let supplied = false;
    for (const argument of argumentsList) {
      if (argument.type === 'SpreadElement') {
        return false;
      }
      if (this.#nativeMember(argument, 'Effect', 'orDie') || this.#nativeMember(argument, 'Effect', 'scoped')) {
        continue;
      }
      const transform = unwrap(argument);
      if (
        transform?.type !== 'CallExpression' ||
        transform.optional ||
        transform.arguments.some((item: ESTree.Node) => item.type === 'SpreadElement')
      ) {
        return false;
      }
      // An outer Layer cannot replace the Clock already supplied inside the program.
      const outerLayer =
        supplied && transform.arguments.length === 1 && this.#nativeMember(transform.callee, 'Effect', 'provide');
      if (!outerLayer) {
        if (!this.#nativeMember(transform.callee, 'Effect', 'provideService') || transform.arguments.length !== 2) {
          return false;
        }
        // The closest provider wins. No earlier unknown key may secretly be an alias of Clock.
        if (
          !supplied &&
          (!this.#nativeMember(transform.arguments[0], 'Clock', 'Clock') || !this.#clockOrigin(transform.arguments[1]))
        ) {
          return false;
        }
        supplied = true;
      }
    }
    return supplied;
  }

  constructor(context: Context) {
    this.#context = context;
    this.#tester = nativeTesterStability(context);
  }

  #callbackIsLive(node: ESTree.Node, parent: Syntax | null): boolean {
    return (
      liveCallbackArgument(this.#context, node, parent) &&
      parent?.type === 'CallExpression' &&
      this.#tester.originIsStable(parent.callee)
    );
  }

  #programIsLive(node: ESTree.VariableDeclarator): boolean {
    if (node.id.type !== 'Identifier' || node.init === null) {
      return false;
    }
    const statement = parentOf(node);
    const binding = lookupVariable(this.#context, node.id);
    return (
      immutableDeclaration(this.#context, node.id) === node &&
      statement !== null &&
      !isExported(statement) &&
      isNativeDeferredProgram(this.#context, node.init) &&
      binding !== null &&
      this.#bindingIsLive(binding)
    );
  }

  #ownerIsLive(node: ESTree.Node | null): boolean {
    if (node?.type === 'VariableDeclarator') {
      return this.#programIsLive(node);
    }
    if (
      node === null ||
      (node.type !== 'FunctionDeclaration' &&
        node.type !== 'FunctionExpression' &&
        node.type !== 'ArrowFunctionExpression')
    ) {
      return false;
    }
    const held = skipWrappers(node, transparent);
    if (this.#callbackIsLive(held.node, held.parent)) {
      if (node.type === 'FunctionExpression' && node.id !== null) {
        const named = lookupVariable(this.#context, node.id);
        if (named !== null && named.references.length > 0) {
          return false;
        }
      }
      return true;
    }
    if (!isNativeEffectHelper(this.#context, node)) {
      return false;
    }
    const binding = functionBinding(this.#context, node);
    return binding !== null && this.#bindingIsLive(binding);
  }

  #referenceIsLive(identifier: ESTree.Node): boolean {
    const held = skipWrappers(identifier, transparent);
    const { parent } = held;
    if (this.#callbackIsLive(held.node, parent)) {
      // The runner invokes its callback; an Effect value is consumed only when returned by that callback.
      return !isNativeDeferredProgram(this.#context, identifier) && !isNativeEffectValue(this.#context, identifier);
    }
    if (parent?.type === 'CallExpression' && parent.callee === held.node) {
      return (
        this.#ownerIsLive(nativeClockExecutionOwner(this.#context, parent)) ||
        this.#layerSetupIsLive(parent) ||
        this.#providedHelperInvocation(parent) ||
        this.#providedGeneratorCall(parent)
      );
    }
    if (parent?.type === 'VariableDeclarator' && parent.init === held.node && parent.id.type === 'Identifier') {
      const declaration = immutableDeclaration(this.#context, parent.id);
      const statement = parentOf(parent);
      const binding = lookupVariable(this.#context, parent.id);
      return (
        declaration === parent &&
        statement !== null &&
        !isExported(statement) &&
        binding !== null &&
        this.#bindingIsLive(binding)
      );
    }
    return (
      (isNativeDeferredProgram(this.#context, identifier) || isNativeEffectValue(this.#context, identifier)) &&
      this.#ownerIsLive(nativeClockExecutionOwner(this.#context, identifier))
    );
  }

  #bindingIsLive(binding: Variable): boolean {
    const cached = this.#proven.get(binding);
    if (cached !== undefined) {
      return cached;
    }
    if (this.#pending.has(binding) || binding.references.some((reference) => reference.isWrite() && !reference.init)) {
      return false;
    }
    const references = binding.references.filter(
      (reference) => !reference.init && !typeReference(reference.identifier),
    );
    if (references.length === 0) {
      return false;
    }
    this.#pending.add(binding);
    const result = references.every((reference) => this.#referenceIsLive(reference.identifier));
    this.#pending.delete(binding);
    this.#proven.set(binding, result);
    return result;
  }

  readonly site = (node: ESTree.Node): boolean => {
    if (node.type === 'ImportSpecifier') {
      const binding = lookupVariable(this.#context, node.local);
      return binding !== null && this.#bindingIsLive(binding);
    }
    return (
      this.#ownerIsLive(nativeClockExecutionOwner(this.#context, node)) ||
      this.#providedClock(node) ||
      this.#layerSetupIsLive(node)
    );
  };
}

/** Only real live registrations and immutable, exclusively reachable Effect helpers establish this clock. */
export const createNativeLiveClockProof = (context: Context): ((node: ESTree.Node) => boolean) =>
  new NativeLiveClockProof(context).site;
