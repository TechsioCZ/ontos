/**
 * Audit A6/B4 (`docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md`) asks for Effect.fn
 * on service operations and handlers. Named Effect.fn standardizes spans and definition/call-site
 * tracing; it does not automatically annotate argument values or prove a plain gen lacks tracing.
 *
 * Matches parameterized non-generator functions returning a recognized Effect.gen call, optionally
 * after leading variable/type declarations. Resolves imported aliases, submodule/root namespaces,
 * configured re-export barrels, static computed members and transparent TypeScript wrappers.
 * Only a whitelist of syntactically Effect-preserving pipeline operators is peeled. Runners,
 * predicates and unknown operators may change the return kind and are deliberately not peeled:
 * syntactic non-reference or a generator at the pipeline start is no proof of its final type.
 *
 * Unknown local aliases/operators/wrappers and functions with control-flow bodies remain outside
 * this bounded detector. Leading declarations can do work; no purity or concurrency inference is
 * made. Generator definitions, zero-argument thunks (default minParams: 1), recognized native
 * definition callbacks and configured exempt callbacks are allowed. Tests/scripts are off by default.
 * Forced Promise/process adapters and deliberate existing instrumentation must be retained.
 * Report-only, with no fixer or suggestions.
 */
import { defineRule } from '@oxlint/plugins';
import { fileURLToPath } from 'node:url';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings, effectMember } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { globToRegExp, isTestFile, normalisePath } from '../shared/paths.ts';

/**
 * Fixture files live at `tools/oxlint/<plugin>/tests/fixtures/<rule>/{valid,invalid}/<repo-like path>`.
 * Stripping that prefix lets fixtures exercise the real production `include` defaults instead of
 * forcing the fixture config to pass loosened options (which `run-on-repo.mts` reuses verbatim).
 */
const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE: readonly string[] = ['apps/**', 'verticals/**', 'packages/**'];

const DEFAULT_IGNORE: readonly string[] = [];

/** Barrels that re-export Effect namespaces verbatim (the Modern.js BFF edge barrel). */
const DEFAULT_REEXPORT_MODULES: readonly string[] = ['@modern-js/plugin-bff/effect-edge'];

/** Effect combinators whose function argument is already the Effect-native definition site. */
const CONSTRUCTOR_MEMBERS: ReadonlySet<string> = new Set(['fn', 'fnUntraced', 'suspend', 'gen']);

/** Curried definition sites: `Effect.fn('span')(function* () {})`. */
const CURRIED_CONSTRUCTOR_MEMBERS: ReadonlySet<string> = new Set(['fn', 'fnUntraced']);

const EFFECT_ROOT_MODULE = 'effect';
const EFFECT_EFFECT_MODULE = /^effect\/(?:.*\/)?Effect$/u;
const GEN_MEMBER = 'gen';
const EFFECT_NAMESPACE = 'Effect';
const PIPE_MEMBER = 'pipe';
/** Namespaces that expose the data-first `pipe(value, …)` function. */
const PIPE_NAMESPACES: ReadonlySet<string> = new Set(['Function', 'Pipeable', 'pipe']);

const MAX_SPAN_NAME = 80;

interface RuleOptions {
  readonly minParams: number;
  readonly allowLeadingConstants: boolean;
  readonly includeTests: boolean;
  readonly includeScripts: boolean;
  readonly include: readonly string[];
  readonly ignore: readonly string[];
  readonly exemptCombinators: readonly string[];
  readonly reexportModules: readonly string[];
}

function stringArray(value: unknown, fallback: readonly string[]): readonly string[] {
  if (!Array.isArray(value)) return fallback;
  const entries = value.filter((entry): entry is string => typeof entry === 'string');
  return entries.length === value.length ? entries : fallback;
}

function readOptions(context: Context): RuleOptions {
  const raw = context.options?.[0];
  const record: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const minParams =
    typeof record.minParams === 'number' && Number.isInteger(record.minParams)
      ? record.minParams
      : 1;
  return {
    minParams: minParams < 0 ? 0 : minParams,
    allowLeadingConstants: record.allowLeadingConstants !== false,
    includeTests: record.includeTests === true,
    includeScripts: record.includeScripts === true,
    include: stringArray(record.include, DEFAULT_INCLUDE),
    ignore: stringArray(record.ignore, DEFAULT_IGNORE),
    exemptCombinators: stringArray(record.exemptCombinators, []),
    reexportModules: stringArray(record.reexportModules, DEFAULT_REEXPORT_MODULES),
  };
}

/** Repo-relative path with the fixture prefix removed, so fixtures behave like real source paths. */
function scopePath(filename: string): string {
  const unified = filename.replaceAll('\\', '/');
  const fixture =
    /(?:^|\/)tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\/(.*)$/u.exec(unified);
  if (fixture?.[1]) return fixture[1];
  const root = fileURLToPath(new URL('../../../../', import.meta.url)).replaceAll('\\', '/');
  return unified.startsWith(root)
    ? unified.slice(root.length)
    : normalisePath(unified).replace(FIXTURE_PREFIX, '');
}

function matchesGlobs(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

function parentOf(node: ESTree.Node): ESTree.Node | null {
  return (node as { parent?: ESTree.Node | null }).parent ?? null;
}

/** Strip wrappers that never change what an expression denotes. */
function unwrap(node: ESTree.Node): ESTree.Node {
  let current = node;
  for (;;) {
    if (
      current.type === 'ChainExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSInstantiationExpression' ||
      current.type === 'ParenthesizedExpression'
    ) {
      const inner = (current as unknown as { expression?: ESTree.Node }).expression;
      if (inner === undefined) return current;
      current = inner;
      continue;
    }
    if (current.type === 'TSTypeAssertion') {
      const inner = (current as unknown as { expression?: ESTree.Node }).expression;
      if (inner === undefined) return current;
      current = inner;
      continue;
    }
    return current;
  }
}

/** Non-computed `.gen`, or computed `["gen"]`. */
function memberName(node: ESTree.MemberExpression): string | null {
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  const property = unwrap(node.property);
  if (property.type === 'Literal' && typeof property.value === 'string') return property.value;
  if (property.type === 'TemplateLiteral' && property.expressions.length === 0)
    return property.quasis[0]?.value.cooked ?? null;
  return null;
}

function lookupVariable(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

/**
 * `true` when the identifier still resolves to an `import` binding. Unresolved names fall back to
 * `true` because the module-level import declaration already proved the binding exists; only a local
 * shadow (parameter, `const`, catch clause, …) rejects the match.
 */
function resolvesToImport(
  context: Context,
  identifier: Extract<ESTree.Node, { type: 'Identifier' }>,
): boolean {
  const variable = lookupVariable(context, identifier);
  if (variable === null || variable.defs.length === 0) return true;
  return variable.defs.some(
    (definition) =>
      definition.type === 'ImportBinding' &&
      definition.parent?.type === 'ImportDeclaration' &&
      definition.parent.importKind !== 'type' &&
      (definition.node.type !== 'ImportSpecifier' || definition.node.importKind !== 'type'),
  );
}

/**
 * Locals bound by `import * as E from "effect"` — `E.Effect.gen` must still be caught. Barrels that
 * re-export the Effect namespaces verbatim (the Modern.js BFF edge barrel) behave identically.
 */
function collectRootNamespaces(
  program: ESTree.Program,
  reexportModules: readonly string[],
): ReadonlySet<string> {
  const locals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    const source = statement.source.value;
    if (source !== EFFECT_ROOT_MODULE && !reexportModules.includes(source)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier') locals.add(specifier.local.name);
    }
  }
  return locals;
}

/**
 * `import { Effect, HttpApiBuilder } from "@modern-js/plugin-bff/effect-edge"` binds the very same
 * `Effect` namespace as `import { Effect } from "effect"`, so BFF handlers must resolve identically.
 */
function collectReexportBindings(
  program: ESTree.Program,
  reexportModules: readonly string[],
): { readonly namespaces: ReadonlyMap<string, string>; readonly found: boolean } {
  const namespaces = new Map<string, string>();
  let found = false;
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (!reexportModules.includes(statement.source.value)) continue;
    found = true;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported =
        specifier.imported.type === 'Identifier'
          ? specifier.imported.name
          : specifier.imported.value;
      namespaces.set(specifier.local.name, imported);
    }
  }
  return { namespaces, found };
}

/** Locals bound by `import { gen as effectGen } from "effect/Effect"`. */
function collectDirectMemberImports(program: ESTree.Program, member: string): ReadonlySet<string> {
  const locals = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== 'ImportDeclaration') continue;
    if (!EFFECT_EFFECT_MODULE.test(statement.source.value)) continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== 'ImportSpecifier') continue;
      const imported =
        specifier.imported.type === 'Identifier'
          ? specifier.imported.name
          : specifier.imported.value;
      if (imported === member) locals.add(specifier.local.name);
    }
  }
  return locals;
}

interface Resolver {
  readonly bindings: EffectBindings;
  readonly rootNamespaces: ReadonlySet<string>;
  readonly genImports: ReadonlySet<string>;
  readonly pipeLocals: ReadonlySet<string>;
}

/** `Effect.gen` / `E.Effect.gen` / `Effect["gen"]` → the namespace + member it denotes. */
function resolveNamespaceMember(
  node: ESTree.MemberExpression,
  context: Context,
  resolver: Resolver,
): { namespace: string; member: string } | null {
  const shared = effectMember(node, resolver.bindings);
  if (shared !== null) {
    return resolvesToImport(context, node.object as Extract<ESTree.Node, { type: 'Identifier' }>)
      ? shared
      : null;
  }
  const member = memberName(node);
  if (member === null) return null;
  const object = unwrap(node.object);
  if (object.type === 'Identifier') {
    if (
      resolver.rootNamespaces.has(object.name) &&
      member === PIPE_MEMBER &&
      resolvesToImport(context, object)
    )
      return { namespace: 'Function', member };
    const namespace = resolver.bindings.namespaces.get(object.name);
    if (namespace === undefined) return null;
    return resolvesToImport(context, object) ? { namespace, member } : null;
  }
  // `E.Effect.gen` where `E` is `import * as E from "effect"`.
  if (object.type !== 'MemberExpression') return null;
  const namespace = memberName(object);
  if (namespace === null) return null;
  if (object.object.type !== 'Identifier') return null;
  if (!resolver.rootNamespaces.has(object.object.name)) return null;
  return resolvesToImport(context, object.object) ? { namespace, member } : null;
}

/** Does this call expression denote `Effect.gen(...)`? */
function isEffectGenCall(node: ESTree.Node, context: Context, resolver: Resolver): boolean {
  if (node.type !== 'CallExpression') return false;
  const callee = unwrap(node.callee);
  if (callee.type === 'Identifier') {
    return resolver.genImports.has(callee.name) && resolvesToImport(context, callee);
  }
  if (callee.type !== 'MemberExpression') return false;
  const matched = resolveNamespaceMember(callee, context, resolver);
  return (
    matched !== null && matched.namespace === EFFECT_NAMESPACE && matched.member === GEN_MEMBER
  );
}

/** The `Effect.gen` callee node, used as the report anchor. */
function genAnchor(node: ESTree.CallExpression): ESTree.Node {
  return unwrap(node.callee);
}

/**
 * Peel `.pipe(...)` chains and `pipe(value, …)` calls so
 * `Effect.gen(...).pipe(Effect.withSpan('X'))` still reduces to the `Effect.gen` call.
 */
function peelPipes(expression: ESTree.Node, context: Context, resolver: Resolver): ESTree.Node {
  let current = unwrap(expression);
  for (let guard = 0; guard < 64; guard += 1) {
    if (current.type !== 'CallExpression') return current;
    const callee = unwrap(current.callee);
    const matched =
      callee.type === 'MemberExpression' ? resolveNamespaceMember(callee, context, resolver) : null;
    const dataFirst =
      callee.type === 'Identifier'
        ? resolver.pipeLocals.has(callee.name) && resolvesToImport(context, callee)
        : matched !== null &&
          matched.member === PIPE_MEMBER &&
          PIPE_NAMESPACES.has(matched.namespace);
    const method =
      callee.type === 'MemberExpression' && memberName(callee) === PIPE_MEMBER && !dataFirst;
    if (!dataFirst && !method) return current;
    // A pipeline can leave Effect (runners, predicates, or arbitrary user functions). Only
    // peel syntactically known Effect-to-Effect operators, never assume a pipe preserves types.
    const preserving = new Set([
      'withSpan',
      'withLogSpan',
      'annotateLogs',
      'annotateSpans',
      'map',
      'flatMap',
      'tap',
      'tapError',
      'tapCause',
      'mapError',
      'catch',
      'catchTag',
      'catchTags',
      'catchCause',
      'provide',
      'provideService',
      'provideServiceEffect',
      'ensuring',
      'onExit',
      'scoped',
      'orDie',
      'retry',
      'timeout',
      'timeoutOrElse',
      'as',
      'asVoid',
      'exit',
      'result',
      'option',
      'withConcurrency',
      'withMinimumLogLevel',
    ]);
    for (const argument of current.arguments.slice(dataFirst ? 1 : 0)) {
      let operator = unwrap(argument);
      if (operator.type === 'CallExpression') operator = unwrap(operator.callee);
      const resolved =
        operator.type === 'MemberExpression'
          ? resolveNamespaceMember(operator, context, resolver)
          : null;
      if (resolved?.namespace !== EFFECT_NAMESPACE || !preserving.has(resolved.member))
        return expression;
    }
    const next = dataFirst ? current.arguments[0] : (callee as ESTree.MemberExpression).object;
    if (next === undefined || next.type === 'SpreadElement') return current;
    current = unwrap(next);
  }
  return current;
}

/**
 * The single expression the function evaluates to, or `null` when the body does more than that.
 * Leading `const`/`let`/`var` declarations are tolerated when `allowLeadingConstants`.
 */
function soleReturnedExpression(
  fn: { readonly body?: ESTree.Node | null },
  allowLeadingConstants: boolean,
): ESTree.Node | null {
  const body = fn.body ?? null;
  if (body === null) return null;
  if (body.type !== 'BlockStatement') return body;
  const statements = body.body.filter((statement) => statement.type !== 'EmptyStatement');
  const last = statements.at(-1);
  if (last === undefined || last.type !== 'ReturnStatement' || last.argument === null) return null;
  for (const statement of statements.slice(0, -1)) {
    if (
      statement.type === 'TSTypeAliasDeclaration' ||
      statement.type === 'TSInterfaceDeclaration' ||
      statement.type === 'TSDeclareFunction'
    )
      continue;
    if (!allowLeadingConstants || statement.type !== 'VariableDeclaration') return null;
  }
  return last.argument;
}

/** The call expression this function is an argument of, skipping value-preserving wrappers. */
function enclosingCallArgument(fn: ESTree.Node): ESTree.CallExpression | null {
  let current: ESTree.Node = fn;
  let parent = parentOf(current);
  while (
    parent !== null &&
    (parent.type === 'TSAsExpression' ||
      parent.type === 'TSSatisfiesExpression' ||
      parent.type === 'TSInstantiationExpression' ||
      parent.type === 'ParenthesizedExpression' ||
      parent.type === 'TSNonNullExpression')
  ) {
    current = parent;
    parent = parentOf(current);
  }
  if (parent === null || parent.type !== 'CallExpression') return null;
  return parent.arguments.includes(current as never) ? parent : null;
}

/**
 * `true` when the function is handed to an Effect definition combinator
 * (`Effect.fn`, `Effect.fnUntraced`, `Effect.suspend`, `Effect.gen`, or the curried
 * `Effect.fn('span')(fn)` form) or to a caller-exempted combinator.
 */
function isExemptArgument(
  fn: ESTree.Node,
  context: Context,
  resolver: Resolver,
  exempt: ReadonlySet<string>,
): boolean {
  const call = enclosingCallArgument(fn);
  if (call === null) return false;
  const callee = unwrap(call.callee);
  if (callee.type === 'MemberExpression') {
    const matched = resolveNamespaceMember(callee, context, resolver);
    if (matched === null) return false;
    if (matched.namespace === EFFECT_NAMESPACE && CONSTRUCTOR_MEMBERS.has(matched.member))
      return true;
    return exempt.has(matched.member);
  }
  // `Effect.fn('span')(function* () {})`
  if (callee.type === 'CallExpression') {
    const inner = unwrap(callee.callee);
    if (inner.type !== 'MemberExpression') return false;
    const matched = resolveNamespaceMember(inner, context, resolver);
    return (
      matched !== null &&
      matched.namespace === EFFECT_NAMESPACE &&
      CURRIED_CONSTRUCTOR_MEMBERS.has(matched.member)
    );
  }
  return false;
}

function keyName(node: ESTree.Node | null | undefined, computed: boolean): string | null {
  if (node === null || node === undefined) return null;
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

/** The declaration name attached to a node, if the node is being named by its parent. */
function nameFromParent(parent: ESTree.Node): string | null {
  switch (parent.type) {
    case 'VariableDeclarator':
      return parent.id.type === 'Identifier' ? parent.id.name : null;
    case 'Property':
      return keyName(parent.key as ESTree.Node, parent.computed === true);
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'AccessorProperty':
      return keyName(parent.key as ESTree.Node, parent.computed === true);
    case 'ClassDeclaration':
    case 'ClassExpression':
      return parent.id !== null && parent.id !== undefined ? parent.id.name : null;
    case 'AssignmentExpression': {
      const left = parent.left;
      if (left.type === 'Identifier') return left.name;
      if (left.type === 'MemberExpression') return memberName(left);
      return null;
    }
    case 'TSModuleDeclaration':
      return parent.id.type === 'Identifier' ? parent.id.name : null;
    default:
      return null;
  }
}

/**
 * `handlers.handle('signIn', (input) => …)` names the operation in its first argument — that string
 * is the handler's real name, far better than the enclosing `const …GroupLive`.
 */
function nameFromLabelledCall(fn: ESTree.Node): string | null {
  const call = enclosingCallArgument(fn);
  if (call === null) return null;
  const first = call.arguments[0];
  if (first === undefined || first === (fn as never)) return null;
  if (first.type !== 'Literal' || typeof first.value !== 'string') return null;
  return /^[A-Za-z_$][\w$]*$/u.test(first.value) ? first.value : null;
}

/** Names of the function and of its enclosing named containers, innermost first. */
function nameChain(fn: ESTree.Node): readonly string[] {
  const names: string[] = [];
  const labelled = nameFromLabelledCall(fn);
  if (labelled !== null) names.push(labelled);
  if (fn.type === 'FunctionDeclaration') {
    const id = (fn as { id?: Extract<ESTree.Node, { type: 'Identifier' }> | null }).id;
    if (id !== null && id !== undefined) names.push(id.name);
  }
  let current: ESTree.Node = fn;
  let parent = parentOf(current);
  while (parent !== null && names.length < 4) {
    const name = nameFromParent(parent);
    if (name !== null) names.push(name);
    current = parent;
    parent = parentOf(current);
  }
  return names;
}

function pascalCase(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** `verticals/contacts/src/services/customer-contact.service.ts` → `CustomerContactService`. */
function fileQualifier(filename: string): string {
  const base = normalisePath(filename).split('/').at(-1) ?? 'module';
  const stem = base.replace(/\.(?:[cm]?[jt]sx?)$/u, '');
  const pascal = pascalCase(stem);
  return pascal.length === 0 ? 'Module' : pascal;
}

interface OperationName {
  readonly name: string;
  readonly suggestedSpanName: string;
}

function describeOperation(fn: ESTree.Node, filename: string): OperationName {
  const names = nameChain(fn);
  const name = names[0] ?? '(anonymous)';
  const qualifier = names[1] ?? fileQualifier(filename);
  const operation = name === '(anonymous)' ? 'operation' : name;
  const span = `${qualifier}.${operation}`;
  if (span.length <= MAX_SPAN_NAME) return { name, suggestedSpanName: span };
  const fallback = `${fileQualifier(filename)}.${operation}`;
  return { name, suggestedSpanName: fallback.length <= MAX_SPAN_NAME ? fallback : operation };
}

function parameterCount(fn: ESTree.Node): number {
  const params = (fn as { params?: readonly ESTree.Node[] }).params;
  return params === undefined ? 0 : params.length;
}

/** A readable parameter list for the suggested `Effect.fn` signature (`input`, `{ … }`, `...rest`). */
function parameterList(fn: ESTree.Node): string {
  const params = (fn as { params?: readonly ESTree.Node[] }).params ?? [];
  const names = params.map((param) => {
    const target =
      param.type === 'TSParameterProperty'
        ? (param as { parameter: ESTree.Node }).parameter
        : param;
    if (target.type === 'Identifier') return target.name;
    if (target.type === 'AssignmentPattern') {
      const left = (target as { left: ESTree.Node }).left;
      return left.type === 'Identifier' ? left.name : '{ … }';
    }
    if (target.type === 'RestElement') {
      const argument = (target as { argument: ESTree.Node }).argument;
      return argument.type === 'Identifier' ? `...${argument.name}` : '...rest';
    }
    if (target.type === 'ArrayPattern') return '[ … ]';
    if (target.type === 'ObjectPattern') {
      const keys = (target as { properties: readonly ESTree.Node[] }).properties
        .map((property) =>
          property.type === 'Property'
            ? keyName(property.key as ESTree.Node, property.computed === true)
            : '…',
        )
        .filter((key): key is string => key !== null);
      return keys.length === 0 ? '{ … }' : `{ ${keys.join(', ')} }`;
    }
    return '{ … }';
  });
  return names.join(', ');
}

/** A6/B4: service operations and handlers must be `Effect.fn`, not `arrow => Effect.gen`. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A6/B4: disallow parameterised functions whose whole body is `Effect.gen(...)`. Define ' +
        "operations and handlers with `Effect.fn('Name.operation')(function* (…) { … })` so every call " +
        'uses named spans and call-site tracing. Syntactic matching covers only known Effect-preserving pipelines; argument annotations are not automatic.',
    },
    messages: {
      preferEffectFn:
        "Operation '{{name}}' returns a syntactically recognized `Effect.gen(...)` program from a plain function. " +
        "Audit A6/B4 calls for `Effect.fn('{{suggestedSpanName}}')(function* ({{params}}) { … })` " +
        'for standard named spans and definition/call-site tracing; retain any deliberate existing instrumentation.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          minParams: { type: 'integer', minimum: 0 },
          allowLeadingConstants: { type: 'boolean' },
          includeTests: { type: 'boolean' },
          includeScripts: { type: 'boolean' },
          include: { type: 'array', items: { type: 'string' } },
          ignore: { type: 'array', items: { type: 'string' } },
          exemptCombinators: { type: 'array', items: { type: 'string' } },
          reexportModules: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        minParams: 1,
        allowLeadingConstants: true,
        includeTests: false,
        includeScripts: false,
        include: [...DEFAULT_INCLUDE],
        ignore: [...DEFAULT_IGNORE],
        exemptCombinators: [],
        reexportModules: [...DEFAULT_REEXPORT_MODULES],
      },
    ],
  },
  create(context) {
    const options = readOptions(context);
    const path = scopePath(context.filename);
    if (!matchesGlobs(path, options.include)) return {};
    if (
      /\.d\.[cm]?ts$/u.test(path) ||
      /(?:^|\/)(?:dist(?:-[^/]+)?|build|\.output|node_modules)\//u.test(path)
    )
      return {};
    if (matchesGlobs(path, options.ignore)) return {};
    if (!options.includeTests && isTestFile(path)) return {};
    if (!options.includeScripts && /(?:^|\/)scripts\//u.test(path)) return {};

    const program = context.sourceCode.ast;
    const direct = collectEffectBindings(program);
    const barrel = collectReexportBindings(program, options.reexportModules);
    const namespaces = new Map(direct.namespaces);
    for (const [local, namespace] of barrel.namespaces) namespaces.set(local, namespace);
    const bindings: EffectBindings = {
      namespaces,
      importsEffect: direct.importsEffect || barrel.found,
    };
    const rootNamespaces = collectRootNamespaces(program, options.reexportModules);
    const genImports = collectDirectMemberImports(program, GEN_MEMBER);
    if (!bindings.importsEffect && rootNamespaces.size === 0) return {};

    const pipeLocals = new Set<string>();
    for (const [local, namespace] of bindings.namespaces) {
      if (namespace === PIPE_MEMBER) pipeLocals.add(local);
    }
    const resolver: Resolver = { bindings, rootNamespaces, genImports, pipeLocals };
    const exempt = new Set(options.exemptCombinators);

    const check = (fn: ESTree.Node): void => {
      if ((fn as { generator?: boolean }).generator === true) return;
      if (parameterCount(fn) < options.minParams) return;
      const returned = soleReturnedExpression(
        fn as { readonly body?: ESTree.Node | null },
        options.allowLeadingConstants,
      );
      if (returned === null) return;
      const peeled = peelPipes(returned, context, resolver);
      if (!isEffectGenCall(peeled, context, resolver)) return;
      if (isExemptArgument(fn, context, resolver, exempt)) return;
      const { name, suggestedSpanName } = describeOperation(fn, context.filename);
      context.report({
        node: genAnchor(peeled as ESTree.CallExpression),
        messageId: 'preferEffectFn',
        data: { name, suggestedSpanName, params: parameterList(fn) },
      });
    };

    return {
      ArrowFunctionExpression: check,
      FunctionExpression: check,
      FunctionDeclaration: check,
    };
  },
});
