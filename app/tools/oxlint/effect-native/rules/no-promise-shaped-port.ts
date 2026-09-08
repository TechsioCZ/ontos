/**
 * effect-native/no-promise-shaped-port
 *
 * Audit A5 (+A1): first-party ports should return Effect; convert at the driver edge.
 * AST/scope only: matches global Promise/PromiseLike (local aliases/unions included),
 * explicit port signatures, and async ownership declarations, including TS wrappers.
 * D-tier exceptions: Effect Promise conversions, direct driver callbacks, import thunks,
 * route entrypoints, the Modern.js adapter, and private helpers used only by such boundaries.
 * Known SDK/fetch/import provenance can identify a local structural mirror. Nested function-
 * returned records (e.g. Drizzle fluent continuations) are not classified as first-party ports.
 * Owned test callbacks also recognize known Promise constructors, factories, and local returns.
 * Limitations: no cross-file SDK/type inference; other inferred returns, dynamic member names
 * and arbitrary higher-order value flow are not resolved. Name/path options are
 * explicit policy controls, not proof of ownership. No fixer or suggestions.
 */
import { defineRule } from '@oxlint/plugins';
import type { Context, ESTree } from '@oxlint/plugins';

import { parentOf } from '../shared/ast.ts';
import { optionRecord } from '../shared/options.ts';
import { stringArray, booleanOption as boolean } from '../shared/options.ts';
import { isTestFile, scopePath, matchesGlobs } from '../shared/paths.ts';

import { createPromisePortTypeResolver } from '../shared/no-promise-port-types.ts';

const DEFAULT_INCLUDE = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
  'tools/**/tests/**',
];
const DEFAULT_IGNORE = [
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  '**/*.d.ts',
  '**/*.config.ts',
  '**/*.config.mts',
  '**/module-federation.config.ts',
];
/** pg `Pool` driver edge: the single place a `Promise` contract is the real contract. */
const DEFAULT_ALLOW_PATHS = ['**/db/client.ts', '**/auth/db/client.ts'];
const DEFAULT_DRIVER_CALLBACKS = ['transaction', 'then', 'catch', 'finally'];
/** Router/framework entrypoint names whose Promise signature is forced (audit D tier). */
const DEFAULT_ALLOW_NAMES = [
  'loader',
  'action',
  'clientLoader',
  'clientAction',
  'middleware',
  'generateMetadata',
  'generateStaticParams',
  'getServerSideProps',
  'getStaticProps',
];
const DEFAULT_PROMISE_TYPES = ['Promise', 'PromiseLike'];
const DEFAULT_EFFECT_MODULES: readonly string[] = [];

const TSX_FILE = /\.[cm]?[jt]sx$/u;

type AnyNode = ESTree.Node & { readonly parent?: ESTree.Node | null };

function readOptions(context: Context) {
  const record = optionRecord(context.options?.[0]);
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    includeTests: boolean(record.includeTests, true),
    includeTsx: boolean(record.includeTsx, true),
    allowPaths: stringArray(record.allowPaths, DEFAULT_ALLOW_PATHS),
    driverCallbacks: stringArray(record.driverCallbacks, DEFAULT_DRIVER_CALLBACKS),
    allowNames: stringArray(record.allowNames, DEFAULT_ALLOW_NAMES),
    effectModules: stringArray(record.effectModules, DEFAULT_EFFECT_MODULES),
    promiseTypes: stringArray(record.promiseTypes, DEFAULT_PROMISE_TYPES),
    includeFunctionDeclarations: boolean(record.includeFunctionDeclarations, true),
  };
}

/** Flatten a static member chain (`E.Effect.tryPromise`) into its identifier segments. */
function memberSegments(node: ESTree.Node): readonly string[] | null {
  let current: ESTree.Node = node;
  if (current.type === 'ChainExpression') current = current.expression as ESTree.Node;
  const segments: string[] = [];
  while (current.type === 'MemberExpression') {
    const member = current as ESTree.MemberExpression;
    if (member.computed) {
      if (member.property.type !== 'Literal' || typeof member.property.value !== 'string')
        return null;
      segments.unshift(member.property.value);
    } else {
      if (member.property.type !== 'Identifier') return null;
      segments.unshift(member.property.name);
    }
    current = member.object as ESTree.Node;
  }
  if (current.type !== 'Identifier') return null;
  segments.unshift(current.name);
  return segments;
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A5/A1: detect explicit Promise-shaped ports and async ownership declarations outside recognized driver/framework adapters. AST and lexical scope resolve local aliases and real imports, not arbitrary cross-file ownership or inferred return types.',
    },
    messages: {
      promisePort:
        "Audit A5: port-shaped signature '{{member}}' returns '{{wrapper}}'. First-party services should expose Effect.Effect<A, E, R>; keep forced Promise conversion at the driver/framework edge.",
      promiseValuePort:
        "Audit A5: port-shaped member '{{member}}' exposes '{{wrapper}}'. Prefer an Effect-returning service for first-party operations; this syntax-only rule cannot infer external ownership.",
      asyncPort:
        "Audit A5: ownership-shaped implementation '{{member}}' is async outside a recognized adapter. First-party services should return Effect.Effect<A, E, R>, with Promise conversion at the driver/framework edge.",
      promiseReturningImplementation:
        "Audit A5: implementation '{{member}}' explicitly returns '{{wrapper}}' outside a recognized adapter. Expose Effect.Effect<A, E, R> from first-party services.",
      testPromiseRoundTrip:
        'Audit A1: owned tests must not wrap Effect Promise runners or Rstest resolves/rejects assertions in an Effect Promise adapter. Compose the Effect directly and assert its value or Exit; reserve Promise adapters for foreign APIs.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          includeTests: { type: 'boolean' },
          includeTsx: { type: 'boolean' },
          allowPaths: { type: 'array', items: { type: 'string' } },
          driverCallbacks: { type: 'array', items: { type: 'string' } },
          allowNames: { type: 'array', items: { type: 'string' } },
          effectModules: { type: 'array', items: { type: 'string' } },
          promiseTypes: { type: 'array', items: { type: 'string' } },
          includeFunctionDeclarations: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        include: DEFAULT_INCLUDE,
        ignore: [...DEFAULT_IGNORE],
        includeTests: true,
        includeTsx: true,
        allowPaths: DEFAULT_ALLOW_PATHS,
        driverCallbacks: DEFAULT_DRIVER_CALLBACKS,
        allowNames: DEFAULT_ALLOW_NAMES,
        effectModules: [...DEFAULT_EFFECT_MODULES],
        promiseTypes: DEFAULT_PROMISE_TYPES,
        includeFunctionDeclarations: true,
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (matchesGlobs(path, options.ignore)) return {};
    if (!matchesGlobs(path, options.include)) return {};
    if (matchesGlobs(path, options.allowPaths)) return {};
    if (!options.includeTests && isTestFile(path)) return {};
    if (!options.includeTsx && TSX_FILE.test(path)) return {};

    const program = context.sourceCode.ast;
    const driverCallbacks = new Set(options.driverCallbacks);
    const allowNames = new Set(options.allowNames);

    const wrappers = new Set([
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TSInstantiationExpression',
      'TSTypeAssertion',
      'ChainExpression',
    ]);
    const unwrap = (node: any): any => {
      while (node && wrappers.has(node.type)) node = node.expression;
      return node;
    };
    const variableFor = (node: any, name: string): any => {
      for (
        let scope: import('@oxlint/plugins').Scope | null = context.sourceCode.getScope(node);
        scope;
        scope = scope.upper
      ) {
        const variable = scope.set.get(name);
        if (variable) return variable;
      }
      return null;
    };
    const computedKey = (key: any): unknown => {
      if (key.type === 'Literal') return key.value;
      if (key.type === 'TemplateLiteral' && !key.expressions.length)
        return key.quasis[0]?.value.cooked;
      return null;
    };
    const importedExportName = (def: any): string | undefined =>
      def.node.imported?.name ?? def.node.imported?.value;
    const importBindingPath = (def: any): string => {
      const source = def.parent?.source?.value;
      const name = importedExportName(def);
      if (source === 'effect' || matchesGlobs(source ?? '', options.effectModules))
        return `effect:${name ?? 'root'}`;
      if (source === 'effect/Effect') return `effect:Effect${name ? `.${name}` : ''}`;
      return `${source}:${name ?? '*'}`;
    };
    const immutableDefinition = (def: any, variable: any): boolean =>
      def.type === 'Variable' &&
      def.parent?.kind === 'const' &&
      !variable.references.some((r: any) => r.isWrite() && !r.init);
    const staticMemberKey = (node: any): string | null => {
      const key = node.computed ? computedKey(node.property) : node.property.name;
      return typeof key === 'string' ? key : null;
    };
    /** Find a registration argument through transparent TypeScript expression wrappers. */
    const callbackRegistration = (node: any): any => {
      let callback = node;
      while (callback.parent && wrappers.has(callback.parent.type)) callback = callback.parent;
      const call = callback.parent;
      return call?.type === 'CallExpression' && call.arguments.includes(callback) ? call : null;
    };
    /** Wrapped suite/layer callbacks receive the runner as their first parameter. */
    const importedRunnerParameter = (def: any, seen: Set<any>): string | null => {
      if (def.type !== 'Parameter' || def.node.params?.[0] !== def.name) return null;
      const registration = callbackRegistration(def.node);
      if (!registration) return null;
      let factory = unwrap(registration.callee);
      while (factory?.type === 'CallExpression') factory = unwrap(factory.callee);
      return /^effect-rstest:(?:\*\.)?(?:describeWrapped|(?:(?:it|test)\.)?layer)$/u.test(
        imported(factory, seen) ?? '',
      )
        ? 'effect-rstest:it'
        : null;
    };
    const importedIdentifier = (node: any, seen: Set<any>): string | null => {
      if (node.type !== 'Identifier') return null;
      const variable = variableFor(node, node.name);
      for (const def of variable?.defs ?? []) {
        if (def.type === 'ImportBinding') return importBindingPath(def);
        const runner = importedRunnerParameter(def, seen);
        if (runner) return runner;
        if (immutableDefinition(def, variable)) return imported(def.node.init, seen);
      }
      return !variable?.defs.length && node.name === 'globalThis' ? 'globalThis' : null;
    };
    const imported = (raw: any, seen = new Set<any>()): string | null => {
      const node = unwrap(raw);
      if (!node || seen.has(node)) return null;
      seen.add(node);
      if (node.type === 'MemberExpression') {
        const left = imported(node.object, seen);
        const key = staticMemberKey(node);
        return left && key !== null ? `${left}.${key}` : null;
      }
      // Playwright's extend factory preserves test identity, unlike arbitrary factories.
      if (node.type === 'CallExpression')
        return imported(node.callee, seen) === '@playwright/test:test.extend'
          ? '@playwright/test:test'
          : null;
      return importedIdentifier(node, seen);
    };
    const walk = (node: any, visit: (node: any) => void): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        node.forEach((child) => walk(child, visit));
        return;
      }
      if (typeof node.type !== 'string') return;
      visit(node);
      for (const [key, value] of Object.entries(node)) if (key !== 'parent') walk(value, visit);
    };
    const functionBody = (raw: any): any => {
      const node = unwrap(raw);
      if (!node) return null;
      if (node.type === 'AwaitExpression') return functionBody(node.argument);
      if (FUNCTION_TYPES.has(node.type)) return functionBody(node.body);
      if (node.type === 'BlockStatement')
        return node.body.length === 1 && node.body[0].type === 'ReturnStatement'
          ? functionBody(node.body[0].argument)
          : null;
      return node;
    };
    const externalValue = (raw: any): boolean => {
      const node = functionBody(raw);
      if (!node) return false;
      if (node.type === 'ImportExpression') return true;
      if (node.type === 'ArrayExpression')
        return node.elements.length > 0 && node.elements.every((item: any) => externalValue(item));
      if (node.type === 'ObjectExpression') {
        let hasAdapter = false;
        const onlyAdapters = node.properties.every((property: any) => {
          if (property.type !== 'Property') return false;
          const value = unwrap(property.value);
          if (['Literal', 'TemplateLiteral'].includes(value?.type)) return true;
          if (!externalValue(value)) return false;
          hasAdapter = true;
          return true;
        });
        return hasAdapter && onlyAdapters;
      }
      if (imported(node) === 'globalThis.fetch') return true;
      if (node.type === 'CallExpression') {
        const path = imported(node.callee) ?? '';
        // Only known forced SDK construction; an arbitrary imported first-party factory is not proof.
        return /^(?:better-auth:betterAuth|drizzle-orm\/[^:]+:drizzle)$/u.test(path);
      }
      return false;
    };
    const mirrorTypes = new Set<any>();
    const markType = (type: any): void => {
      if (!type) return;
      if (['TSTypeAnnotation', 'TSTypeOperator', 'TSParenthesizedType'].includes(type.type)) {
        markType(type.typeAnnotation);
        return;
      }
      if (type.type === 'TSArrayType') {
        markType(type.elementType);
        return;
      }
      if (type.type !== 'TSTypeReference' || type.typeName.type !== 'Identifier') return;
      const def = variableFor(type.typeName, type.typeName.name)?.defs.find((d: any) =>
        ['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(d.node.type),
      );
      if (def) mirrorTypes.add(def.node);
    };
    walk(program, (node) => {
      if (node.type === 'VariableDeclarator' && externalValue(node.init))
        markType(node.id.typeAnnotation);
      if (node.type === 'AssignmentPattern' && externalValue(node.right))
        markType(node.left.typeAnnotation);
      if (FUNCTION_TYPES.has(node.type) && externalValue(node)) markType(node.returnType);
      if (node.type === 'TSSatisfiesExpression' && externalValue(node.expression))
        markType(node.typeAnnotation);
    });
    const withinMirror = (node: any): boolean => {
      for (let current = node; current; current = current.parent)
        if (mirrorTypes.has(current)) return true;
      return false;
    };

    /** `Effect.tryPromise` / `Eff.promise` / `E.Effect.tryPromise` / bare `tryPromise`. */
    const isPromiseBoundaryCall = (call: ESTree.CallExpression): boolean => {
      return /^effect:(?:root\.)?Effect\.(?:promise|tryPromise|tryMapPromise)$/u.test(
        imported(call.callee) ?? '',
      );
    };

    const isEffectPromiseRunner = (node: any): boolean =>
      /^effect:(?:root\.)?Effect\.runPromise(?:Exit)?$/u.test(imported(node) ?? '');
    const isPromiseAssertion = (node: any): boolean => {
      if (node.type !== 'MemberExpression') return false;
      if (!['resolves', 'rejects'].includes(staticMemberKey(node) ?? '')) return false;
      const assertion = unwrap(node.object);
      return (
        assertion?.type === 'CallExpression' &&
        /^(?:effect-rstest|@rstest\/core):(?:\*\.)?expect$/u.test(imported(assertion.callee) ?? '')
      );
    };

    /** Syntax-only test round trips: real imports, not arbitrary methods or cross-file runners. */
    const checkTestPromiseAdapter = (call: ESTree.CallExpression): void => {
      if (!isTestFile(path) || !isPromiseBoundaryCall(call)) return;
      let roundTrip = false;
      walk(call.arguments, (node) => {
        if (node.type === 'CallExpression' && isEffectPromiseRunner(node.callee)) roundTrip = true;
        if (isPromiseAssertion(node)) roundTrip = true;
      });
      if (roundTrip) context.report({ node: call, messageId: 'testPromiseRoundTrip' });
    };

    /** A `.transaction(...)` / `.then(...)` style driver callback the Promise protocol forces. */
    const isDriverCallbackCall = (call: ESTree.CallExpression): boolean => {
      const segments = memberSegments(call.callee as ESTree.Node);
      if (segments === null || segments.length < 2) return false;
      return driverCallbacks.has(segments[segments.length - 1] ?? '');
    };

    /**
     * `true` when `node` sits inside the argument subtree of an `Effect.tryPromise`-style boundary,
     * or is a callback handed to a driver method (`db.transaction(async (tx) => ...)`).
     */
    const atDriverEdge = (node: AnyNode): boolean => {
      let current: AnyNode | null = node;
      while (current !== null) {
        const parent = parentOf(current);
        if (parent === null) return false;
        if (parent.type === 'CallExpression') {
          const call = parent as unknown as ESTree.CallExpression;
          const isArgument = (call.arguments as readonly ESTree.Node[]).includes(
            current as ESTree.Node,
          );
          if (isArgument && isPromiseBoundaryCall(call)) return true;
          // A driver callback is forced, not every service constructed inside its body.
          if (isArgument && unwrap(current) === unwrap(node) && isDriverCallbackCall(call))
            return true;
        }
        current = parent;
      }
      return false;
    };

    /** Unit-test callbacks are owned programs, unlike SDK mocks and Playwright adapters. */
    const atOwnedTestCallback = (node: any): boolean => {
      if (!isTestFile(path)) return false;
      const call = callbackRegistration(node);
      if (!call) return false;
      let callee = call.callee;
      // Parameterized registrations, e.g. test.each(rows)(name, callback).
      while (callee.type === 'CallExpression') callee = callee.callee;
      return /^(?:effect-rstest|@rstest\/core|vitest|node:test):(?:\*\.)?(?:test|it)(?:\.|$)/u.test(
        imported(callee) ?? '',
      );
    };

    /** A callback supplied directly to the imported test runner is a framework entrypoint. */
    const atTestBoundary = (node: any): boolean => {
      if (!isTestFile(path)) return false;
      for (let current = node; current?.parent; current = current.parent) {
        if (current !== node && FUNCTION_TYPES.has(current.type)) return false;
        const call = current.parent;
        if (
          call.type === 'CallExpression' &&
          call.arguments.includes(current) &&
          /^(?:node:test:(?:test|it|before|after|beforeEach|afterEach|\*)(?:\.|$)|(?:@playwright\/test|@rstest\/core|vitest):(?:test|it|beforeAll|afterAll|beforeEach|afterEach|rstest\.mock)(?:\.|$)|effect-rstest:(?:\*\.)?(?:beforeAll|afterAll|beforeEach|afterEach)$)/u.test(
            imported(call.callee) ?? '',
          )
        )
          return true;
      }
      return false;
    };

    const invokedAtDriverEdge = (value: any): boolean =>
      value.parent?.type === 'CallExpression' &&
      value.parent.callee === value &&
      atDriverEdge(value.parent);
    const foreignThunkValue = (value: any): any => {
      if (
        value.parent?.type === 'Property' &&
        value.parent.value === value &&
        value.parent.key.name === 'try'
      )
        return value.parent.parent;
      return value;
    };
    const isForeignThunkReference = (ref: any): boolean => {
      if (invokedAtDriverEdge(ref.identifier)) return true;
      const value = foreignThunkValue(ref.identifier);
      const call = value.parent;
      return (
        call?.type === 'CallExpression' &&
        call.arguments.includes(value) &&
        isPromiseBoundaryCall(call)
      );
    };
    const annotatedFunctionParameter = (node: any): any => {
      let current = node;
      while (current?.parent && current.parent.type !== 'Identifier') current = current.parent;
      const parameter = current?.parent;
      return parameter && FUNCTION_TYPES.has(parameter.parent?.type) ? parameter : null;
    };

    /** Only the actual thunk forwarded to Effect's foreign Promise conversion has that contract. */
    const isForeignThunkParameter = (node: any): boolean => {
      const parameter = annotatedFunctionParameter(node);
      if (!parameter) return false;
      if (isTestFile(path) && exemptHelper(parameter.parent)) return true;
      const variable = variableFor(parameter, parameter.name);
      const refs = variable?.references.filter((ref: any) => ref.isRead()) ?? [];
      return refs.length > 0 && refs.every(isForeignThunkReference);
    };

    /** Better Auth owns this exact hook signature, not arbitrary services nested in its options. */
    const isAuthHookPath = (keys: readonly string[]): boolean =>
      keys.length === 4 &&
      keys[0] === 'databaseHooks' &&
      ['user', 'session', 'account', 'verification'].includes(keys[1]!) &&
      ['create', 'update', 'delete'].includes(keys[2]!) &&
      ['before', 'after'].includes(keys[3]!);
    const isObjectValue = (parent: any, current: any): boolean =>
      parent.type === 'Property' &&
      parent.value === current &&
      parent.parent?.type === 'ObjectExpression';
    const authPropertyKey = (parent: any): unknown =>
      parent.computed ? computedKey(parent.key) : (parent.key.name ?? parent.key.value);
    const atAuthHook = (node: any): boolean => {
      let current = node;
      const keys: string[] = [];
      while (current.parent) {
        const parent = current.parent;
        if (wrappers.has(parent.type)) {
          current = parent;
          continue;
        }
        if (!isObjectValue(parent, current)) break;
        const key = authPropertyKey(parent);
        if (typeof key !== 'string') return false;
        keys.unshift(key);
        current = parent.parent;
      }
      const call = current.parent;
      return (
        call?.type === 'CallExpression' &&
        call.arguments[0] === current &&
        imported(call.callee) === 'better-auth:betterAuth' &&
        isAuthHookPath(keys)
      );
    };

    /** Functions already reported, so nested closures are not reported a second time. */
    const reportedFunctions = new Set<number>();

    const insideReportedFunction = (node: AnyNode): boolean => {
      let current: AnyNode | null = parentOf(node);
      while (current !== null) {
        if (FUNCTION_TYPES.has(current.type) && reportedFunctions.has(current.start)) return true;
        current = parentOf(current);
      }
      return false;
    };

    /** The `Promise` / `PromiseLike` reference of a return/value annotation, if any. */
    const promiseReference = createPromisePortTypeResolver(variableFor, options.promiseTypes);

    const knownPromiseBinding = (node: any, seen: Set<any>): boolean => {
      const variable = variableFor(node, node.name);
      return (variable?.defs ?? []).some(
        (def: any) =>
          immutableDefinition(def, variable) &&
          !FUNCTION_TYPES.has(unwrap(def.node.init)?.type) &&
          returnsKnownPromise(def.node.init, seen),
      );
    };
    /** Walk returns in this body, never returns belonging to a nested function. */
    const bodyReturnsPromise = (node: any, seen: Set<any>): boolean => {
      const visit = (statement: any): boolean => {
        if (!statement || typeof statement !== 'object') return false;
        if (Array.isArray(statement)) return statement.some(visit);
        if (FUNCTION_TYPES.has(statement.type)) return false;
        if (statement.type === 'ReturnStatement')
          return returnsKnownPromise(statement.argument, new Set(seen));
        return Object.entries(statement).some(([key, value]) => key !== 'parent' && visit(value));
      };
      return visit(node);
    };
    const isGlobalPromiseConstruction = (node: any): boolean => {
      const segments = memberSegments(unwrap(node.callee));
      if (!segments || variableFor(node.callee, segments[0]!)?.defs.length) return false;
      const globalSegments = segments[0] === 'globalThis' ? segments.slice(1) : segments;
      if (globalSegments[0] !== 'Promise') return false;
      if (node.type === 'NewExpression') return globalSegments.length === 1;
      return (
        globalSegments.length === 2 &&
        ['resolve', 'reject', 'all', 'allSettled', 'any', 'race'].includes(globalSegments[1]!)
      );
    };
    const localCallReturnsPromise = (callee: any, seen: Set<any>): boolean => {
      if (callee.type !== 'Identifier') return false;
      const variable = variableFor(callee, callee.name);
      return (variable?.defs ?? []).some((def: any) => {
        const fn = unwrap(def.type === 'FunctionName' ? def.node : def.node.init);
        return (
          FUNCTION_TYPES.has(fn?.type) &&
          !variable.references.some((ref: any) => ref.isWrite() && !ref.init) &&
          returnsKnownPromise(fn, seen)
        );
      });
    };
    const callReturnsPromise = (node: any, seen: Set<any>): boolean => {
      if (isGlobalPromiseConstruction(node)) return true;
      if (node.type !== 'CallExpression') return false;
      return isEffectPromiseRunner(node.callee) || localCallReturnsPromise(node.callee, seen);
    };
    const functionReturnsPromise = (node: any, seen: Set<any>): boolean =>
      node.async === true ||
      promiseReference(node.returnType) !== null ||
      returnsKnownPromise(node.body, seen);

    /** Bounded same-file Promise provenance for owned test registrations, not general type inference. */
    const returnsKnownPromise = (raw: any, seen = new Set<any>()): boolean => {
      const node = unwrap(raw);
      if (!node || seen.has(node)) return false;
      seen.add(node);
      if (FUNCTION_TYPES.has(node.type)) return functionReturnsPromise(node, seen);
      if (node.type === 'Identifier') return knownPromiseBinding(node, seen);
      if (node.type === 'BlockStatement') return bodyReturnsPromise(node, seen);
      if (node.type === 'ConditionalExpression')
        return (
          returnsKnownPromise(node.consequent, new Set(seen)) ||
          returnsKnownPromise(node.alternate, new Set(seen))
        );
      if (node.type === 'CallExpression' || node.type === 'NewExpression')
        return callReturnsPromise(node, seen);
      return false;
    };

    /** Human-readable name for the reported member, used in the message. */
    const memberName = (node: AnyNode): string => {
      const key = (node as { readonly key?: ESTree.Node | null }).key ?? null;
      if (key !== null) {
        if (key.type === 'Identifier') return key.name;
        if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
        if (key.type === 'PrivateIdentifier') return `#${key.name}`;
      }
      const id = (node as { readonly id?: ESTree.Node | null }).id ?? null;
      if (id !== null && id.type === 'Identifier') return id.name;
      return 'this member';
    };

    /** Walk out of a function/type node to the declaration that names it. */
    const namedOwner = (node: AnyNode): AnyNode => {
      let current: AnyNode | null = node;
      let hops = 0;
      while (current !== null && hops < 6) {
        if (
          [
            'Property',
            'MethodDefinition',
            'TSAbstractMethodDefinition',
            'PropertyDefinition',
            'TSAbstractPropertyDefinition',
            'TSPropertySignature',
            'TSMethodSignature',
            'TSTypeAliasDeclaration',
            'VariableDeclarator',
            'FunctionDeclaration',
          ].includes(current.type)
        ) {
          return current;
        }
        current = parentOf(current);
        hops += 1;
      }
      return node;
    };

    const nameOf = (node: AnyNode): string => {
      const owner = namedOwner(node);
      if (owner.type === 'VariableDeclarator') {
        const id = (owner as unknown as ESTree.VariableDeclarator).id;
        return id.type === 'Identifier' ? id.name : 'this binding';
      }
      if (owner.type === 'TSTypeAliasDeclaration')
        return (owner as unknown as ESTree.TSTypeAliasDeclaration).id.name;
      return memberName(owner);
    };

    const report = (node: ESTree.Node, messageId: string, data: Record<string, string>): void => {
      if (withinMirror(node)) return;
      // A5 owns the service surface, not signatures of fluent driver continuations.
      // Nested function-returned records are intentionally outside this AST-only port model.
      let child: any = node;
      for (let ancestor = (node as any).parent; ancestor; ancestor = ancestor.parent) {
        if (['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(ancestor.type)) break;
        if (ancestor.type === 'TSFunctionType' && ancestor.returnType === child) return;
        child = ancestor;
      }
      context.report({ node, messageId, data } as never);
    };

    // ---------------------------------------------------------------- (A) declared ports

    const isPortBindingOwner = (owner: AnyNode): boolean => {
      let declaration = parentOf(owner);
      if (
        declaration &&
        ['AssignmentPattern', 'TSParameterProperty', 'RestElement'].includes(declaration.type)
      )
        declaration = parentOf(declaration);
      if (!declaration) return false;
      return (
        declaration.type === 'VariableDeclarator' ||
        FUNCTION_TYPES.has(declaration.type) ||
        [
          'TSDeclareFunction',
          'TSEmptyBodyFunctionExpression',
          'TSFunctionType',
          'TSMethodSignature',
          'TSCallSignatureDeclaration',
        ].includes(declaration.type)
      );
    };
    const isPortAnnotationOwner = (owner: AnyNode | null): boolean => {
      if (!owner) return false;
      if (owner.type === 'Identifier' || owner.type === 'RestElement')
        return isPortBindingOwner(owner);
      return [
        'TSPropertySignature',
        'TSIndexSignature',
        'PropertyDefinition',
        'TSAbstractPropertyDefinition',
      ].includes(owner.type);
    };

    /** `TSFunctionType` positions that declare a port member rather than a callback parameter. */
    const isPortFunctionTypePosition = (node: AnyNode): boolean => {
      let parent = parentOf(node);
      while (
        parent &&
        [
          'TSUnionType',
          'TSIntersectionType',
          'TSParenthesizedType',
          'TSTypeParameterInstantiation',
          'TSTypeReference',
          'TSArrayType',
          'TSOptionalType',
          'TSRestType',
          'TSTypeOperator',
        ].includes(parent.type)
      )
        parent = parentOf(parent);
      if (parent === null) return false;
      if (parent.type === 'TSTypeAliasDeclaration') return true;
      if (parent.type !== 'TSTypeAnnotation') return false;
      return isPortAnnotationOwner(parentOf(parent));
    };

    // ---------------------------------------------------------------- (B) implementations

    const isModuleScopeDeclarator = (declarator: AnyNode): boolean => {
      const declaration = parentOf(declarator);
      if (declaration === null || declaration.type !== 'VariableDeclaration') return false;
      const owner = parentOf(declaration);
      if (owner === null) return false;
      if (owner.type === 'Program' || owner.type === 'TSModuleBlock') return true;
      return (
        (owner.type === 'ExportNamedDeclaration' || owner.type === 'ExportDefaultDeclaration') &&
        ['Program', 'TSModuleBlock'].includes(parentOf(owner)?.type ?? '')
      );
    };

    /** An implementation position that *owns* behaviour: a service record, a class, a module binding. */
    const referencedAsObjectValue = (declarator: any): boolean => {
      const id = declarator.id;
      if (id.type !== 'Identifier') return false;
      return variableFor(id, id.name)?.references.some(
        (r: any) =>
          r.isRead() && r.identifier.parent && isObjectValue(r.identifier.parent, r.identifier),
      );
    };
    const isImplementationPosition = (node: AnyNode): boolean => {
      let current = node;
      let parent = parentOf(current);
      while (parent && wrappers.has(parent.type)) {
        current = parent;
        parent = parentOf(current);
      }
      if (parent === null) return false;
      if (parent.type === 'Property') return isObjectValue(parent, current);
      if (['MethodDefinition', 'TSAbstractMethodDefinition'].includes(parent.type)) return true;
      if (['PropertyDefinition', 'TSAbstractPropertyDefinition'].includes(parent.type)) return true;
      if (parent.type === 'VariableDeclarator') {
        return (
          (parent as unknown as ESTree.VariableDeclarator).init ===
            (current as unknown as ESTree.Expression) &&
          (isModuleScopeDeclarator(parent) || referencedAsObjectValue(parent))
        );
      }
      return false;
    };

    /** A module-scope `function` declaration — the same ownership position as a module binding. */
    const isModuleScopeFunction = (node: AnyNode): boolean => {
      const parent = parentOf(node);
      if (parent === null) return false;
      if (parent.type === 'Program') return true;
      return (
        (parent.type === 'ExportNamedDeclaration' || parent.type === 'ExportDefaultDeclaration') &&
        parentOf(parent)?.type === 'Program'
      );
    };

    const isDirectAdapter = (body: any): boolean => {
      if (body?.type === 'ImportExpression') return true;
      return (
        body?.type === 'CallExpression' &&
        imported(body.callee) === '@modern-js/plugin-bff/effect-client:runEffectRequest'
      );
    };
    const exportedOwner = (owner: any): boolean =>
      owner.parent?.type === 'ExportNamedDeclaration' ||
      owner.parent?.parent?.type === 'ExportNamedDeclaration';
    const exemptReference = (ref: any, fn: any, seen: Set<any>): boolean => {
      if (atDriverEdge(ref.identifier) || atTestBoundary(ref.identifier)) return true;
      for (let current = ref.identifier.parent; current; current = current.parent) {
        if (current === fn) return true;
        if (FUNCTION_TYPES.has(current.type)) return exemptHelper(current, new Set(seen));
      }
      return false;
    };
    const exemptAnonymousCallback = (fn: any, seen: Set<any>): boolean => {
      const call = fn.parent;
      if (call?.type !== 'CallExpression' || !call.arguments.includes(fn)) return false;
      for (let current = call.parent; current; current = current.parent) {
        if (FUNCTION_TYPES.has(current.type)) return exemptHelper(current, new Set(seen));
      }
      return false;
    };
    const outsideFunction = (ref: any, fn: any): boolean => {
      for (let current = ref.identifier.parent; current; current = current.parent) {
        if (current === fn) return false;
      }
      return true;
    };
    const exemptNamedHelper = (owner: any, fn: any, seen: Set<any>): boolean => {
      if (exportedOwner(owner)) return false;
      const variable = variableFor(owner.id, owner.id.name);
      const refs = (variable?.references.filter((ref: any) => ref.isRead()) ?? []).filter(
        (ref: any) => outsideFunction(ref, fn),
      );
      return refs.length > 0 && refs.every((ref: any) => exemptReference(ref, fn, seen));
    };
    const exemptHelper = (fn: any, seen = new Set<any>()): boolean => {
      if (seen.has(fn)) return false;
      seen.add(fn);
      if (atTestBoundary(fn)) return true;
      if (isDirectAdapter(functionBody(fn))) return true;
      const owner = namedOwner(fn);
      const id = (owner as any).id;
      if (!id || id.type !== 'Identifier') return exemptAnonymousCallback(fn, seen);
      return exemptNamedHelper(owner, fn, seen);
    };

    const ownsImplementation = (node: AnyNode): boolean =>
      node.type === 'FunctionDeclaration'
        ? options.includeFunctionDeclarations && isModuleScopeFunction(node)
        : isImplementationPosition(node);
    const allowedRoute = (node: AnyNode, member: string): boolean =>
      allowNames.has(member) &&
      /(?:^|\/)src\/routes\//u.test(path) &&
      ['VariableDeclarator', 'FunctionDeclaration'].includes(namedOwner(node).type);
    const atImplementationBoundary = (node: AnyNode): boolean =>
      atDriverEdge(node) || atAuthHook(node) || atTestBoundary(node) || exemptHelper(node);
    const reportImplementation = (
      node: AnyNode,
      member: string,
      isAsync: boolean,
      wrapper: string | null,
    ): void => {
      reportedFunctions.add(node.start);
      report(node as ESTree.Node, isAsync ? 'asyncPort' : 'promiseReturningImplementation', {
        member,
        wrapper: wrapper ?? 'Promise',
      });
    };
    const reportOwnedImplementation = (
      node: AnyNode,
      isAsync: boolean,
      wrapper: string | null,
    ): void => {
      if (!ownsImplementation(node)) return;
      if (atImplementationBoundary(node)) return;
      if (insideReportedFunction(node)) return;
      const member = nameOf(node);
      // Framework router entrypoints (`loader`, `action`, ...) are forced to return a Promise.
      if (allowedRoute(node, member)) return;
      reportImplementation(node, member, isAsync, wrapper);
    };
    const checkImplementation = (node: AnyNode): void => {
      const fn = node as unknown as {
        readonly async?: boolean;
        readonly returnType?: ESTree.TSTypeAnnotation | null;
      };
      const wrapper = promiseReference(fn.returnType);
      const isAsync = fn.async === true;
      const ownedTest = atOwnedTestCallback(node);
      if (!isAsync && wrapper === null && !(ownedTest && returnsKnownPromise(node))) return;
      if (ownedTest) {
        reportImplementation(node, 'test callback', isAsync, wrapper);
        return;
      }
      reportOwnedImplementation(node, isAsync, wrapper);
    };
    const isAliasPortReference = (node: AnyNode): boolean => {
      const annotation = parentOf(node);
      if (annotation?.type === 'TSTypeAliasDeclaration') return true;
      if (annotation?.type !== 'TSTypeAnnotation') return false;
      const owner = parentOf(annotation);
      return owner?.type === 'Identifier' || owner?.type === 'RestElement';
    };

    return {
      CallExpression: checkTestPromiseAdapter,
      TSInterfaceHeritage: (node: ESTree.TSInterfaceHeritage) => {
        const wrapper = promiseReference(node);
        if (wrapper === null) return;
        report(node, 'promisePort', {
          member:
            node.parent.type === 'TSInterfaceDeclaration' ? node.parent.id.name : 'this interface',
          wrapper,
        });
      },
      TSTypeReference: (node: ESTree.TSTypeReference) => {
        if (!isAliasPortReference(node as unknown as AnyNode)) return;
        if (!isPortFunctionTypePosition(node as unknown as AnyNode)) return;
        const wrapper = promiseReference(node, true);
        if (wrapper === null) return;
        if (isForeignThunkParameter(node) || atTestBoundary(node) || atDriverEdge(node)) return;
        report(node, 'promisePort', {
          member: nameOf(node as unknown as AnyNode),
          wrapper,
        });
      },
      TSMethodSignature: (node: ESTree.TSMethodSignature) => {
        const wrapper = promiseReference(node.returnType);
        if (wrapper === null) return;
        report(node, 'promisePort', {
          member: memberName(node as unknown as AnyNode),
          wrapper,
        });
      },
      TSCallSignatureDeclaration: (node: ESTree.TSCallSignatureDeclaration) => {
        const wrapper = promiseReference(node.returnType);
        if (wrapper === null) return;
        report(node, 'promisePort', { member: 'the call signature', wrapper });
      },
      TSConstructSignatureDeclaration: (node: ESTree.TSConstructSignatureDeclaration) => {
        const wrapper = promiseReference(node.returnType);
        if (wrapper === null) return;
        report(node, 'promisePort', {
          member: 'the construct signature',
          wrapper,
        });
      },
      TSFunctionType: (node: ESTree.TSFunctionType) => {
        const wrapper = promiseReference(node.returnType);
        if (wrapper === null) return;
        if (!isPortFunctionTypePosition(node as unknown as AnyNode)) return;
        if (isForeignThunkParameter(node) || atTestBoundary(node)) return;
        report(node, 'promisePort', {
          member: nameOf(node as unknown as AnyNode),
          wrapper,
        });
      },
      TSPropertySignature: (node: ESTree.TSPropertySignature) => {
        const wrapper = promiseReference(node.typeAnnotation);
        if (wrapper === null) return;
        report(node, 'promiseValuePort', {
          member: memberName(node as unknown as AnyNode),
          wrapper,
        });
      },
      PropertyDefinition: (node: ESTree.PropertyDefinition) => {
        const wrapper = promiseReference(node.typeAnnotation);
        if (wrapper === null) return;
        if (atDriverEdge(node as unknown as AnyNode)) return;
        report(node, 'promiseValuePort', {
          member: memberName(node as unknown as AnyNode),
          wrapper,
        });
      },
      TSEmptyBodyFunctionExpression: (node: ESTree.Function) =>
        checkImplementation(node as unknown as AnyNode),
      TSDeclareFunction: (node: any) => {
        const wrapper = promiseReference(node.returnType);
        if (wrapper) report(node, 'promisePort', { member: nameOf(node), wrapper });
      },
      FunctionDeclaration: (node: ESTree.Function) =>
        checkImplementation(node as unknown as AnyNode),
      FunctionExpression: (node: ESTree.Function) =>
        checkImplementation(node as unknown as AnyNode),
      ArrowFunctionExpression: (node: ESTree.ArrowFunctionExpression) =>
        checkImplementation(node as unknown as AnyNode),
    } as never;
  },
});
