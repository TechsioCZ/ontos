import type { Context, ESTree, Variable } from '@oxlint/plugins';

import { asNode, memberName, parentOf, skipWrappers, unwrap, walk } from './ast.ts';
import type { Syntax } from './ast.ts';
import { lookupVariable } from './bindings.ts';
import { isNativeEffectHelper, nativeClockExecutionOwner } from './native-live-effect-flow.ts';

type FunctionNode = ESTree.ArrowFunctionExpression | ESTree.Function;
type Tester = 'namespace' | 'it' | 'live' | 'registration' | 'builder' | 'property' | 'test' | 'testBuilder';
const testRunnerModule = 'effect-rstest';
const transparent = new Set(['ParenthesizedExpression', 'ChainExpression', 'TSNonNullExpression']);
const directMethods = new Set(['only', 'skip', 'fails']);
const builderMethods = new Set(['each', 'runIf', 'skipIf']);

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
    const initial = asNode(immutableDeclaration(context, node)?.init);
    return initial === null ? null : tester(context, initial, seen);
  }
  if (node.type === 'CallExpression') {
    const kind = tester(context, node.callee, seen);
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

const isExported = (node: ESTree.Node): boolean => {
  const parent = parentOf(node);
  return parent?.type === 'ExportNamedDeclaration' || parent?.type === 'ExportDefaultDeclaration';
};

const functionBinding = (context: Context, fn: FunctionNode): Variable | null => {
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
        return (kind !== 'builder' && kind !== 'testBuilder') || proof.valueUseIsStable(parent);
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

  #ownerIsLive(node: ESTree.Node | null): boolean {
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
      return true;
    }
    if (parent?.type === 'CallExpression' && parent.callee === held.node) {
      return this.#ownerIsLive(nativeClockExecutionOwner(this.#context, parent));
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
    return false;
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
    return this.#ownerIsLive(nativeClockExecutionOwner(this.#context, node));
  };
}

/** Only real live registrations and immutable, exclusively reachable Effect helpers establish this clock. */
export const createNativeLiveClockProof = (context: Context): ((node: ESTree.Node) => boolean) =>
  new NativeLiveClockProof(context).site;
