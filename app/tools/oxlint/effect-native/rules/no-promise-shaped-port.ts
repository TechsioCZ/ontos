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
 * Limitations: no cross-file SDK/type inference; inferred non-async Promise returns, dynamic
 * member names and arbitrary higher-order value flow are not resolved. Name/path options are
 * explicit policy controls, not proof of ownership. No fixer or suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree } from '@oxlint/plugins';

import { collectEffectBindings, type EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/** Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`. */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE = ['apps/**', 'verticals/**', 'packages/**'];
const DEFAULT_IGNORE = [
  '**/dist/**',
  '**/build/**',
  '**/node_modules/**',
  'tools/**',
  '**/*.d.ts',
  '**/*.config.ts',
  '**/*.config.mts',
  '**/module-federation.config.ts',
  '**/scripts/**',
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

const EFFECT_NAMESPACE = 'Effect';
const EFFECT_ROOT_MODULE = 'effect';
/** `Effect.*` members whose argument subtree *is* the blessed Promise↔Effect conversion point. */
const PROMISE_BOUNDARY_MEMBERS = new Set(['promise', 'tryPromise', 'tryMapPromise']);

const TSX_FILE = /\.[cm]?[jt]sx$/u;

type AnyNode = ESTree.Node & { readonly parent?: ESTree.Node | null };

interface RuleOptions {
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly includeTests: boolean;
  readonly includeTsx: boolean;
  readonly allowPaths: readonly string[];
  readonly driverCallbacks: readonly string[];
  readonly allowNames: readonly string[];
  readonly effectModules: readonly string[];
  readonly promiseTypes: readonly string[];
  readonly includeFunctionDeclarations: boolean;
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    includeTests: boolean(record.includeTests, false),
    includeTsx: boolean(record.includeTsx, false),
    allowPaths: stringArray(record.allowPaths, DEFAULT_ALLOW_PATHS),
    driverCallbacks: stringArray(record.driverCallbacks, DEFAULT_DRIVER_CALLBACKS),
    allowNames: stringArray(record.allowNames, DEFAULT_ALLOW_NAMES),
    effectModules: stringArray(record.effectModules, DEFAULT_EFFECT_MODULES),
    promiseTypes: stringArray(record.promiseTypes, DEFAULT_PROMISE_TYPES),
    includeFunctionDeclarations: boolean(record.includeFunctionDeclarations, true),
  };
}

function scopePath(filename: string): string {
  return normalisePath(filename).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function parentOf(node: AnyNode | null): AnyNode | null {
  return (node?.parent as AnyNode | null | undefined) ?? null;
}

/** Same-file `type X = ...` names, so a local `type Promise = ...` shadow disables the match. */
function collectTypeAliasNames(program: ESTree.Program): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (statements: readonly ESTree.Node[]): void => {
    for (const statement of statements) {
      if (statement.type === 'TSTypeAliasDeclaration') names.add(statement.id.name);
      else if (statement.type === 'ExportNamedDeclaration' && statement.declaration !== null) {
        visit([statement.declaration as ESTree.Node]);
      } else if (
        statement.type === 'TSModuleDeclaration' &&
        statement.body?.type === 'TSModuleBlock'
      ) {
        visit(statement.body.body as readonly ESTree.Node[]);
      }
    }
  };
  visit(program.body as readonly ESTree.Node[]);
  return names;
}

/** Locals bound to the whole `effect` root barrel (`import * as E from "effect"` → `E.Effect.tryPromise`). */
function collectEffectBarrels(program: ESTree.Program): ReadonlySet<string> {
  const barrels = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (statement.source.value !== EFFECT_ROOT_MODULE) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') barrels.add(specifier.local.name);
    }
  }
  return barrels;
}

/** Extra namespaces re-exported by first-party barrels listed in `effectModules`. */
function collectBarrelBindings(
  program: ESTree.Program,
  modules: readonly string[],
): ReadonlyMap<string, string> {
  const extra = new Map<string, string>();
  if (modules.length === 0) return extra;
  const patterns = modules.map((module) => globToRegExp(module));
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;
    if (!patterns.some((pattern) => pattern.test(source))) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier') {
        const imported =
          specifier.imported.type === 'Identifier'
            ? specifier.imported.name
            : specifier.imported.value;
        extra.set(specifier.local.name, imported);
      } else if (specifier.type === 'ImportNamespaceSpecifier') {
        extra.set(specifier.local.name, specifier.local.name);
      }
    }
  }
  return extra;
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

/** Flatten `Promise` / `Effect.Effect` type names into their dotted segments. */
function typeNameSegments(name: ESTree.TSTypeName): readonly string[] | null {
  if (name.type === 'Identifier') return [name.name];
  if (name.type === 'TSQualifiedName') {
    const left = typeNameSegments(name.left);
    return left === null ? null : [...left, name.right.name];
  }
  return null;
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
        includeTests: false,
        includeTsx: false,
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
    const effect: EffectBindings = collectEffectBindings(program);
    const barrelBindings = collectBarrelBindings(program, options.effectModules);
    const namespaces = new Map<string, string>([...effect.namespaces, ...barrelBindings]);
    const barrels = collectEffectBarrels(program);
    const localTypeAliases = collectTypeAliasNames(program);
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
    const imported = (raw: any, seen = new Set<any>()): string | null => {
      const node = unwrap(raw);
      if (!node || seen.has(node)) return null;
      seen.add(node);
      if (node.type === 'MemberExpression') {
        const left = imported(node.object, seen);
        const key = !node.computed
          ? node.property.name
          : node.property.type === 'Literal'
            ? node.property.value
            : node.property.type === 'TemplateLiteral' && !node.property.expressions.length
              ? node.property.quasis[0]?.value.cooked
              : null;
        return left && typeof key === 'string' ? `${left}.${key}` : null;
      }
      if (node.type !== 'Identifier') return null;
      const variable = variableFor(node, node.name);
      for (const def of variable?.defs ?? []) {
        if (def.type === 'ImportBinding') {
          const source = def.parent?.source?.value;
          const name = def.node.imported?.name ?? def.node.imported?.value;
          if (
            source === 'effect' ||
            options.effectModules.some((m) => globToRegExp(m).test(source ?? ''))
          )
            return `effect:${name ?? 'root'}`;
          if (source === 'effect/Effect') return `effect:Effect${name ? `.${name}` : ''}`;
          return `${source}:${name ?? '*'}`;
        }
        if (
          def.type === 'Variable' &&
          def.parent?.kind === 'const' &&
          !variable.references.some((r: any) => r.isWrite() && !r.init)
        )
          return imported(def.node.init, seen);
      }
      return !variable?.defs.length && node.name === 'globalThis' ? 'globalThis' : null;
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

    /** Better Auth owns this exact hook signature, not arbitrary services nested in its options. */
    const atAuthHook = (node: any): boolean => {
      let current = node;
      const keys: string[] = [];
      while (current.parent) {
        const parent = current.parent;
        if (wrappers.has(parent.type)) {
          current = parent;
          continue;
        }
        if (
          parent.type !== 'Property' ||
          parent.value !== current ||
          parent.parent?.type !== 'ObjectExpression'
        )
          break;
        const key = !parent.computed
          ? (parent.key.name ?? parent.key.value)
          : parent.key.type === 'Literal'
            ? parent.key.value
            : parent.key.type === 'TemplateLiteral' && !parent.key.expressions.length
              ? parent.key.quasis[0]?.value.cooked
              : null;
        if (typeof key !== 'string') return false;
        keys.unshift(key);
        current = parent.parent;
      }
      const call = current.parent;
      return (
        call?.type === 'CallExpression' &&
        call.arguments[0] === current &&
        imported(call.callee) === 'better-auth:betterAuth' &&
        keys.length === 4 &&
        keys[0] === 'databaseHooks' &&
        ['user', 'session', 'account', 'verification'].includes(keys[1]!) &&
        ['create', 'update', 'delete'].includes(keys[2]!) &&
        ['before', 'after'].includes(keys[3]!)
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
    const promiseReference = (
      annotation: ESTree.TSTypeAnnotation | null | undefined,
    ): string | null => {
      if (annotation === null || annotation === undefined) return null;
      const resolve = (raw: any, seen = new Set<any>()): string | null => {
        if (!raw || seen.has(raw)) return null;
        seen.add(raw);
        if (raw.type === 'TSTypeAnnotation' || raw.type === 'TSParenthesizedType')
          return resolve(raw.typeAnnotation, seen);
        if (raw.type === 'TSUnionType' || raw.type === 'TSIntersectionType') {
          for (const item of raw.types) {
            const result = resolve(item, new Set(seen));
            if (result) return result;
          }
          return null;
        }
        if (raw.type !== 'TSTypeReference') return null;
        const names = typeNameSegments(raw.typeName);
        if (!names) return null;
        const name = names.at(-1)!;
        if (
          names.length === 2 &&
          names[0] === 'globalThis' &&
          !variableFor(raw, 'globalThis')?.defs.length &&
          options.promiseTypes.includes(name)
        )
          return `${name}<…>`;
        if (names.length !== 1) return null;
        const variable = variableFor(raw.typeName, name);
        const alias = variable?.defs.find(
          (d: any) => d.node.type === 'TSTypeAliasDeclaration',
        )?.node;
        if (alias) return resolve(alias.typeAnnotation, seen);
        if (variable?.defs.length || !options.promiseTypes.includes(name)) return null;
        return `${name}<…>`;
      };
      return resolve(annotation);
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
          current.type === 'Property' ||
          current.type === 'MethodDefinition' ||
          current.type === 'TSAbstractMethodDefinition' ||
          current.type === 'PropertyDefinition' ||
          current.type === 'TSAbstractPropertyDefinition' ||
          current.type === 'TSPropertySignature' ||
          current.type === 'TSMethodSignature' ||
          current.type === 'TSTypeAliasDeclaration' ||
          current.type === 'VariableDeclarator' ||
          current.type === 'FunctionDeclaration'
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
      for (let ancestor = (node as any).parent; ancestor; ancestor = ancestor.parent) {
        if (['TSTypeAliasDeclaration', 'TSInterfaceDeclaration'].includes(ancestor.type)) break;
        if (ancestor.type === 'TSFunctionType') return;
      }
      context.report({ node, messageId, data } as never);
    };

    // ---------------------------------------------------------------- (A) declared ports

    /** `TSFunctionType` positions that declare a port member rather than a callback parameter. */
    const isPortFunctionTypePosition = (node: AnyNode): boolean => {
      let current = node;
      let parent = parentOf(current);
      while (
        parent &&
        ['TSUnionType', 'TSIntersectionType', 'TSParenthesizedType'].includes(parent.type)
      ) {
        current = parent;
        parent = parentOf(current);
      }
      if (parent === null) return false;
      if (parent.type === 'TSTypeAliasDeclaration') return true;
      if (parent.type !== 'TSTypeAnnotation') return false;
      const owner = parentOf(parent);
      if (owner === null) return false;
      // `const deleteRecovery: (id: string) => Promise<void> = ...` — a declared binding, not a
      // callback parameter (whose annotated `Identifier` has a function as its parent).
      if (owner.type === 'Identifier') return parentOf(owner)?.type === 'VariableDeclarator';
      return (
        owner.type === 'TSPropertySignature' ||
        owner.type === 'TSIndexSignature' ||
        owner.type === 'PropertyDefinition' ||
        owner.type === 'TSAbstractPropertyDefinition'
      );
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
    const isImplementationPosition = (node: AnyNode): boolean => {
      let current = node;
      let parent = parentOf(current);
      while (parent && wrappers.has(parent.type)) {
        current = parent;
        parent = parentOf(current);
      }
      if (parent === null) return false;
      if (parent.type === 'Property') {
        return (
          (parent as unknown as ESTree.ObjectProperty).value ===
            (current as unknown as ESTree.Expression) &&
          parentOf(parent)?.type === 'ObjectExpression'
        );
      }
      if (parent.type === 'MethodDefinition' || parent.type === 'TSAbstractMethodDefinition')
        return true;
      if (parent.type === 'PropertyDefinition' || parent.type === 'TSAbstractPropertyDefinition')
        return true;
      if (parent.type === 'VariableDeclarator') {
        return (
          (parent as unknown as ESTree.VariableDeclarator).init ===
            (current as unknown as ESTree.Expression) &&
          (isModuleScopeDeclarator(parent) ||
            (() => {
              const id = (parent as any).id;
              if (id.type !== 'Identifier') return false;
              return variableFor(id, id.name)?.references.some(
                (r: any) =>
                  r.isRead() &&
                  r.identifier.parent?.type === 'Property' &&
                  r.identifier.parent.value === r.identifier &&
                  r.identifier.parent.parent?.type === 'ObjectExpression',
              );
            })())
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

    const exemptHelper = (fn: any, seen = new Set<any>()): boolean => {
      if (seen.has(fn)) return false;
      seen.add(fn);
      const body = functionBody(fn);
      if (body?.type === 'ImportExpression') return true;
      if (
        body?.type === 'CallExpression' &&
        imported(body.callee) === '@modern-js/plugin-bff/effect-client:runEffectRequest'
      )
        return true;
      const owner = namedOwner(fn);
      const id = (owner as any).id;
      if (!id || id.type !== 'Identifier') return false;
      if (
        (owner as any).parent?.type === 'ExportNamedDeclaration' ||
        (owner as any).parent?.parent?.type === 'ExportNamedDeclaration'
      )
        return false;
      const variable = variableFor(id, id.name);
      const refs = variable?.references.filter((r: any) => r.isRead()) ?? [];
      if (!refs.length) return false;
      return refs.every((ref: any) => {
        const call = ref.identifier.parent;
        if (call?.type !== 'CallExpression' || call.callee !== ref.identifier) return false;
        if (atDriverEdge(call)) return true;
        for (let current = call.parent; current; current = current.parent)
          if (FUNCTION_TYPES.has(current.type)) return exemptHelper(current, new Set(seen));
        return false;
      });
    };

    const checkImplementation = (node: AnyNode): void => {
      const fn = node as unknown as {
        readonly async?: boolean;
        readonly returnType?: ESTree.TSTypeAnnotation | null;
      };
      const wrapper = promiseReference(fn.returnType);
      const isAsync = fn.async === true;
      if (!isAsync && wrapper === null) return;
      if (node.type === 'FunctionDeclaration') {
        if (!options.includeFunctionDeclarations) return;
        if (!isModuleScopeFunction(node)) return;
      } else if (!isImplementationPosition(node)) return;
      if (atDriverEdge(node) || atAuthHook(node) || exemptHelper(node)) return;
      if (insideReportedFunction(node)) return;
      const member = nameOf(node);
      // Framework router entrypoints (`loader`, `action`, ...) are forced to return a Promise.
      if (
        allowNames.has(member) &&
        /(?:^|\/)src\/routes\//u.test(path) &&
        ['VariableDeclarator', 'FunctionDeclaration'].includes(namedOwner(node).type)
      )
        return;
      reportedFunctions.add(node.start);
      report(node as ESTree.Node, isAsync ? 'asyncPort' : 'promiseReturningImplementation', {
        member,
        wrapper: wrapper ?? 'Promise',
      });
    };

    return {
      TSMethodSignature: (node: ESTree.TSMethodSignature) => {
        const wrapper = promiseReference(node.returnType);
        if (wrapper === null) return;
        report(node, 'promisePort', { member: memberName(node as unknown as AnyNode), wrapper });
      },
      TSCallSignatureDeclaration: (node: ESTree.TSCallSignatureDeclaration) => {
        const wrapper = promiseReference(node.returnType);
        if (wrapper === null) return;
        report(node, 'promisePort', { member: 'the call signature', wrapper });
      },
      TSConstructSignatureDeclaration: (node: ESTree.TSConstructSignatureDeclaration) => {
        const wrapper = promiseReference(node.returnType);
        if (wrapper === null) return;
        report(node, 'promisePort', { member: 'the construct signature', wrapper });
      },
      TSFunctionType: (node: ESTree.TSFunctionType) => {
        const wrapper = promiseReference(node.returnType);
        if (wrapper === null) return;
        if (!isPortFunctionTypePosition(node as unknown as AnyNode)) return;
        report(node, 'promisePort', { member: nameOf(node as unknown as AnyNode), wrapper });
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
