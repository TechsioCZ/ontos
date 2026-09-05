/**
 * effect-native/no-ambient-date
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - A2 "Make Schema the sole authority for contracts and domain models" —
 *     "Use `Schema.DateTimeUtc` and explicit date-only codecs instead of generic strings and hand
 *     calendar arithmetic."
 *   - B5 "Adopt Effect's ADTs and temporal model consistently" — timestamps are one of the named
 *     highest-value targets; the codebase re-declares them as ambient `Date` values instead.
 *   - B2 "Build one Effect-aware testing harness" — "real sleeps/timers": a test that reads the
 *     wall clock cannot be driven by `TestClock`, so it is either flaky or slow.
 *
 * ## What is detected
 *
 *   1. `ambientDateConstruction` — `new Date(...)` on the unshadowed global `Date`, any arity,
 *      including `new globalThis.Date()` and a local alias (`const D = Date; new D()`).
 *      Every such site reads or fabricates an instant outside `Clock`, so `TestClock` cannot move
 *      it and the value is not a `DateTime.Utc`.
 *   2. `ambientClockRead` — `Date.now()`, `Date.parse()`, `Date.UTC()`, `performance.now()`,
 *      `process.hrtime()` and `process.hrtime.bigint()` on the unshadowed globals, including
 *      computed (`Date["now"]()`), template-keyed (``Date[`now`]()``), optional (`Date?.now()`),
 *      `globalThis`/`global`/`window`/`self`-qualified, aliased (`const p = performance`),
 *      destructured (`const { now } = Date`) and point-free (`map(Date.now)`) forms.
 *   3. `dateMethodCall` — a member named in `dateMethods` (`getTime`, `toISOString`, `setHours`,
 *      `getFullYear`, …) on a syntactically Date-shaped receiver (construction, explicit Date
 *      annotation, same-file typed property, or Date.prototype),
 *      whether it is called (`row.createdAt.getTime()`), computed (`row.createdAt["getTime"]()`),
 *      taken point-free (`const f = at.toISOString`) or reached through the prototype
 *      (`Date.prototype.toISOString.call(value)`). These are hand serialisation and hand calendar
 *      arithmetic on a `Date`.
 *   4. `handDurationArithmetic` — a `*` / `/` chain over the literals 60, 1000, 3600, 86400, 60000,
 *      3600000 or 86400000 whose owning binding/property/function name — or, for a multiplication,
 *      one of its own operand names — ends in `Ms`, `Millis`, `Milliseconds`, `Seconds`, `Minutes`,
 *      `Hours`, `Days`, `Timeout`, `Ttl`, `Lease`, `Backoff`, `Skew` or `Duration`. That is a
 *      `Duration` written out by hand as a magic number.
 *
 * ## What is deliberately allowed
 *
 *   - D tier, "deliberately malformed casts in tests" / fixture data: with the default
 *     `testMode: "clock-only"` a test file only reports the *ambient clock* reads
 *     (`new Date()` with no arguments, `Date.now`, `performance.now`, `process.hrtime`).
 *     Frozen fixture instants (`new Date("2026-01-01T00:00:00Z")`), the deterministic
 *     `Date.parse("2026-01-01T00:00:00Z")` that is the exact same construct, assertions that format
 *     a fixture (`expected.toISOString()`) and fixture duration constants stay legal; only the
 *     wall-clock reads that `TestClock` must own are reported. `testMode: "off"` skips tests
 *     entirely, `testMode: "all"` applies the production rules there too.
 *   - D tier, "Promise adapters forced by … Playwright": a function body handed to
 *     `page.evaluate` / `waitForFunction` / `evaluateHandle` / `$eval` / `$$eval` /
 *     `addInitScript` is serialised and executed inside the browser page. No Effect runtime,
 *     `Clock` or `TestClock` is reachable there, so a clock read inside it has no Effect-native
 *     replacement and is never reported (`browserEvaluatedMethods`).
 *   - Anything that is not the global: a shadowed/imported `Date`, `performance` or `process`
 *     binding never reports (the scope chain is walked; a binding whose definition is anything
 *     other than `const X = <the global>` wins, and `registry.Date` / `registry.performance` are
 *     plain properties).
 *   - Effect's own temporal API: a `dateMethods` name read off an `effect` / `effect/*` namespace
 *     binding (`DateTime.*`, `Schema.*`, `Duration.*`) is never a hand-rolled `Date` call.
 *   - A unit conversion handed straight to an `effect` namespace call
 *     (`DateTime.makeUnsafe(epochSeconds * 1000)`, `Duration.millis(ttlSeconds * 1000)`): that is
 *     the Effect-native edge, not a hand-rolled duration. Likewise an unnamed division such as
 *     `Clock.currentTimeMillis.pipe(Effect.map((milliseconds) => Math.floor(milliseconds / 1000)))`,
 *     which is already Clock-backed.
 *   - `this.` / `super.` receivers: a service method that happens to be called `getDate` is not a
 *     `Date`. Configurable via `ignoreReceivers`.
 *   - Type positions (`createdAt: Date`) are not expressions and are never visited.
 *   - One span, one diagnostic: `new Date(x).toISOString()` reports the hand serialisation only;
 *     the inner `new Date` is not reported a second time on the same expression.
 *
 * Scope lives in the rule (`includePaths` defaults to `apps/**`, `verticals/**`, `packages/**`,
 * `scripts/**`), so `oxlint.config.ts` only needs `'effect-native/no-ambient-date': 'error'`.
 * `ignore` exempts globs, `ignoreScripts` drops `scripts/**`, and `testPaths` / `productionPaths`
 * override the built-in test-file detection. Fixtures mirror repo paths and exercise these defaults;
 * only the common fixture prefix is stripped, just as in the sibling rules.
 *
 * Unknown/imported receiver types are not guessed from method names: a service's getDate is not
 * evidence of a Date. Alias/type walks are bounded and do not perform generic type inference.
 * Report-only: no fixers, no suggestions.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope, Variable } from '@oxlint/plugins';

import { collectEffectBindings } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { isScriptFile, isTestFile, matchesAny, normalisePath } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/** Wrappers that do not change "is this expression the callee / object of its parent". */
const TRANSPARENT_PARENTS = new Set([
  'ParenthesizedExpression',
  'ChainExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'TSInstantiationExpression',
  'TSTypeAssertion',
]);

/** Global object → members that read (or fabricate) an instant outside `Clock`. */
const CLOCK_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Date', new Set(['now', 'parse', 'UTC'])],
  ['performance', new Set(['now'])],
  ['process', new Set(['hrtime'])],
]);

/**
 * The subset that `TestClock` must own, reported even in `testMode: "clock-only"`.
 *
 * `Date.parse` is deliberately absent: `Date.parse("2026-01-01T00:00:00Z")` is a pure function of a
 * frozen fixture string — it reads no clock, cannot be flaky and is the same construct as
 * `new Date("<literal>")`, which clock-only mode already blesses.
 */
const TEST_CLOCK_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['Date', new Set(['now'])],
  ['performance', new Set(['now'])],
  ['process', new Set(['hrtime'])],
]);

/** Identifiers that name the global object itself, so `globalThis.Date` resolves to `Date`. */
const GLOBAL_ROOTS = new Set(['globalThis', 'global', 'window', 'self']);

/** Literal factors that only appear when a Duration is spelled out by hand. */
const DURATION_LITERALS = new Set([60, 1000, 3600, 86400, 60000, 3600000, 86400000]);

/** A binding/property name that declares it holds a duration. */
const DURATION_NAME =
  /(?:Ms|Millis|Milliseconds|Seconds|Minutes|Hours|Days|Timeout|Ttl|Lease|Backoff|Skew|Duration)$/iu;

const DEFAULT_DATE_METHODS: readonly string[] = [
  'getTime',
  'toISOString',
  'setDate',
  'setUTCDate',
  'setHours',
  'setUTCHours',
  'setMonth',
  'setFullYear',
  'getFullYear',
  'getMonth',
  'getDate',
  'getHours',
  'getTimezoneOffset',
];

/**
 * Callee names whose function arguments are serialised and evaluated inside a browser page
 * (Playwright / Puppeteer). Audit D tier keeps driver-forced adapters; nothing Effect-native is
 * reachable from a page-evaluated body.
 */
const DEFAULT_BROWSER_EVALUATED_METHODS: readonly string[] = [
  'evaluate',
  'evaluateHandle',
  'evaluateOnNewDocument',
  'waitForFunction',
  'addInitScript',
  '$eval',
  '$$eval',
];

const FIXTURE_PREFIX = /^tools\/oxlint\/[^/]+\/tests\/fixtures\/[^/]+\/(?:valid|invalid)\//u;

const DEFAULT_INCLUDE_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
];

const TEST_MODES = new Set(['clock-only', 'all', 'off']);

const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
  'FunctionDeclaration',
]);

interface RuleOptions {
  readonly testMode: string;
  readonly dateMethods: readonly string[];
  readonly allowDurationArithmetic: boolean;
  readonly ignore: readonly string[];
  readonly ignoreScripts: boolean;
  readonly includePaths: readonly string[];
  readonly testPaths: readonly string[];
  readonly productionPaths: readonly string[];
  readonly ignoreReceivers: readonly string[];
  readonly browserEvaluatedMethods: readonly string[];
}

const DEFAULTS: RuleOptions = {
  testMode: 'clock-only',
  dateMethods: DEFAULT_DATE_METHODS,
  allowDurationArithmetic: false,
  ignore: [],
  ignoreScripts: false,
  includePaths: DEFAULT_INCLUDE_PATHS,
  testPaths: [],
  productionPaths: [],
  ignoreReceivers: ['this', 'super'],
  browserEvaluatedMethods: DEFAULT_BROWSER_EVALUATED_METHODS,
};

function stringList(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? (value as readonly string[])
    : fallback;
}

function readOptions(raw: unknown): RuleOptions {
  const given = (raw ?? {}) as Partial<Record<keyof RuleOptions, unknown>>;
  const includePaths = stringList(given.includePaths, DEFAULTS.includePaths);
  return {
    testMode:
      typeof given.testMode === 'string' && TEST_MODES.has(given.testMode)
        ? given.testMode
        : DEFAULTS.testMode,
    dateMethods: stringList(given.dateMethods, DEFAULTS.dateMethods),
    allowDurationArithmetic:
      typeof given.allowDurationArithmetic === 'boolean'
        ? given.allowDurationArithmetic
        : DEFAULTS.allowDurationArithmetic,
    ignore: stringList(given.ignore, DEFAULTS.ignore),
    ignoreScripts:
      typeof given.ignoreScripts === 'boolean' ? given.ignoreScripts : DEFAULTS.ignoreScripts,
    includePaths: includePaths.length > 0 ? includePaths : DEFAULTS.includePaths,
    testPaths: stringList(given.testPaths, DEFAULTS.testPaths),
    productionPaths: stringList(given.productionPaths, DEFAULTS.productionPaths),
    ignoreReceivers: stringList(given.ignoreReceivers, DEFAULTS.ignoreReceivers),
    browserEvaluatedMethods: stringList(
      given.browserEvaluatedMethods,
      DEFAULTS.browserEvaluatedMethods,
    ),
  };
}

function parentOf(node: AnyNode): AnyNode | null {
  return (node as { parent?: AnyNode | null }).parent ?? null;
}

/** Strip parentheses / `as` / `!` / optional-chain wrappers from an expression. */
function unwrap(node: AnyNode, depth: number): AnyNode {
  if (depth > 8 || !TRANSPARENT_PARENTS.has(node.type)) return node;
  const inner = (node as { expression?: AnyNode }).expression;
  return inner === undefined ? node : unwrap(inner, depth + 1);
}

/** Climb through parentheses/type wrappers; returns the outermost equivalent node and its parent. */
function skipWrappers(node: AnyNode): { readonly node: AnyNode; readonly parent: AnyNode | null } {
  let current = node;
  let parent = parentOf(current);
  while (parent !== null && TRANSPARENT_PARENTS.has(parent.type)) {
    current = parent;
    parent = parentOf(current);
  }
  return { node: current, parent };
}

function resolveVariable(context: Context, name: string, from: AnyNode): Variable | null {
  let scope: Scope | null = context.sourceCode.getScope(from);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
}

function staticPropertyName(node: ESTree.MemberExpression): string | null {
  const property = node.property as AnyNode;
  if (!node.computed)
    return property.type === 'Identifier' ? (property as ESTree.IdentifierName).name : null;
  if (property.type === 'Literal') {
    const value = (property as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  }
  // `at[`toISOString`]()` — a template literal with no interpolation is still a static key.
  if (property.type === 'TemplateLiteral') {
    const template = property as ESTree.TemplateLiteral;
    if (template.expressions.length !== 0 || template.quasis.length !== 1) return null;
    return template.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/**
 * The global this expression denotes (`Date`, `performance`, `process`, `globalThis`, …), or `null`.
 *
 * Resolves three indirections that would otherwise evade the rule:
 *   - `globalThis.Date` / `window.performance` (a member off an unshadowed global root),
 *   - `const AmbientDate = Date` (a `const` whose sole initialiser is the global),
 * while a plain property of a user object (`registry.Date`) stays `null`.
 */
function resolveGlobalName(context: Context, raw: AnyNode, depth = 0): string | null {
  if (depth > 6) return null;
  const node = unwrap(raw, 0);
  if (node.type === 'Identifier') {
    const name = (node as ESTree.IdentifierReference).name;
    const variable = resolveVariable(context, name, node);
    if (variable === null || variable.defs.length === 0) return name;
    if (variable.defs.length !== 1) return null;
    if (variable.references.some((reference) => reference.isWrite() && !reference.init))
      return null;
    const def = variable.defs[0];
    if (def === undefined || def.type !== 'Variable') return null;
    const declarator = def.node as AnyNode;
    if (declarator.type !== 'VariableDeclarator') return null;
    const id = (declarator as ESTree.VariableDeclarator).id as AnyNode;
    if (id.type !== 'Identifier') return null;
    const init = (declarator as ESTree.VariableDeclarator).init as AnyNode | null | undefined;
    if (init === null || init === undefined) return null;
    return resolveGlobalName(context, init, depth + 1);
  }
  if (node.type === 'MemberExpression') {
    const member = node as ESTree.MemberExpression;
    const root = resolveGlobalName(context, member.object as AnyNode, depth + 1);
    if (root === null || !GLOBAL_ROOTS.has(root)) return null;
    return staticPropertyName(member);
  }
  return null;
}

/** The call this expression is the callee of, or the expression itself when used point-free. */
function callSiteOf(node: AnyNode): AnyNode {
  const { node: reference, parent } = skipWrappers(node);
  if (
    parent !== null &&
    parent.type === 'CallExpression' &&
    (parent as ESTree.CallExpression).callee === reference
  ) {
    return parent;
  }
  if (
    parent !== null &&
    parent.type === 'NewExpression' &&
    (parent as ESTree.NewExpression).callee === reference
  ) {
    return parent;
  }
  return reference;
}

function numericValue(node: AnyNode): number | null {
  if (node.type !== 'Literal') return null;
  const value = (node as { value?: unknown }).value;
  return typeof value === 'number' ? value : null;
}

/** Walk a `*` / `/` chain looking for one of the magic duration factors. */
function containsDurationLiteral(node: AnyNode, depth: number): boolean {
  if (depth > 8) return false;
  const literal = numericValue(node);
  if (literal !== null) return DURATION_LITERALS.has(literal);
  if (node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression') {
    const inner = (node as { expression?: AnyNode }).expression;
    return inner === undefined ? false : containsDurationLiteral(inner, depth + 1);
  }
  if (node.type !== 'BinaryExpression') return false;
  const binary = node as ESTree.BinaryExpression;
  if (binary.operator !== '*' && binary.operator !== '/') return false;
  return (
    containsDurationLiteral(binary.left as AnyNode, depth + 1) ||
    containsDurationLiteral(binary.right as AnyNode, depth + 1)
  );
}

/** `true` when a wider `*` / `/` expression encloses this one, so only the outermost reports. */
function isInsideDurationChain(node: AnyNode): boolean {
  const { node: reference, parent } = skipWrappers(node);
  if (parent === null || parent.type !== 'BinaryExpression') return false;
  const binary = parent as ESTree.BinaryExpression;
  if (binary.operator !== '*' && binary.operator !== '/') return false;
  return (binary.left as AnyNode) === reference || (binary.right as AnyNode) === reference;
}

function keyName(key: AnyNode): string | null {
  if (key.type === 'Identifier') return (key as ESTree.IdentifierName).name;
  if (key.type === 'Literal') {
    const value = (key as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  }
  return null;
}

/** Duration-suffixed identifier / property name appearing as a factor of the chain. */
function operandDurationName(node: AnyNode, depth: number): string | null {
  if (depth > 8) return null;
  if (node.type === 'Identifier') {
    const name = (node as ESTree.IdentifierReference).name;
    return DURATION_NAME.test(name) ? name : null;
  }
  if (node.type === 'MemberExpression') {
    const name = staticPropertyName(node as ESTree.MemberExpression);
    return name !== null && DURATION_NAME.test(name) ? name : null;
  }
  if (
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSNonNullExpression'
  ) {
    const inner = (node as { expression?: AnyNode }).expression;
    return inner === undefined ? null : operandDurationName(inner, depth + 1);
  }
  if (node.type !== 'BinaryExpression') return null;
  const binary = node as ESTree.BinaryExpression;
  if (binary.operator !== '*' && binary.operator !== '/') return null;
  return (
    operandDurationName(binary.left as AnyNode, depth + 1) ??
    operandDurationName(binary.right as AnyNode, depth + 1)
  );
}

/**
 * `true` when the arithmetic is an argument of an `effect` namespace call — `DateTime.makeUnsafe`,
 * `Duration.millis`, … Converting at that edge is the Effect-native seam, not a hand-rolled duration.
 */
function isEffectCallArgument(node: AnyNode, bindings: EffectBindings): boolean {
  let current: AnyNode | null = node;
  for (let depth = 0; current !== null && depth < 8; depth += 1) {
    const parent: AnyNode | null = parentOf(current);
    if (parent === null) return false;
    if (parent.type === 'CallExpression' || parent.type === 'NewExpression') {
      const callee = (parent as { callee: AnyNode }).callee;
      if (callee === current) return false;
      if (callee.type !== 'MemberExpression') return false;
      const object = (callee as ESTree.MemberExpression).object as AnyNode;
      return (
        object.type === 'Identifier' &&
        bindings.namespaces.has((object as ESTree.IdentifierReference).name)
      );
    }
    current = parent;
  }
  return false;
}

/** Name of the binding / property / assignment target / enclosing function this expression flows into. */
function ownerName(node: AnyNode): string | null {
  let current: AnyNode | null = parentOf(node);
  for (let depth = 0; current !== null && depth < 12; depth += 1) {
    switch (current.type) {
      case 'VariableDeclarator': {
        const id = (current as ESTree.VariableDeclarator).id as AnyNode;
        return id.type === 'Identifier' ? (id as ESTree.BindingIdentifier).name : null;
      }
      case 'Property':
      case 'PropertyDefinition':
      case 'MethodDefinition':
        return keyName((current as { key: AnyNode }).key);
      case 'AssignmentExpression': {
        const left = (current as ESTree.AssignmentExpression).left as AnyNode;
        if (left.type === 'Identifier') return (left as ESTree.IdentifierReference).name;
        if (left.type === 'MemberExpression')
          return staticPropertyName(left as ESTree.MemberExpression);
        return null;
      }
      case 'AssignmentPattern': {
        const left = (current as { left: AnyNode }).left;
        return left.type === 'Identifier' ? (left as ESTree.BindingIdentifier).name : null;
      }
      // `export const leaseMs = (): number => 5 * 60 * 1000` / `function claimTimeoutMs() { return … }`:
      // the duration name sits on the function, not on the initialiser.
      case 'FunctionDeclaration':
      case 'FunctionExpression': {
        const id = (current as { id?: AnyNode | null }).id ?? null;
        if (id !== null && id.type === 'Identifier') return (id as ESTree.BindingIdentifier).name;
        current = parentOf(current);
        continue;
      }
      case 'ArrowFunctionExpression':
      case 'ReturnStatement':
      case 'BlockStatement':
      case 'BinaryExpression':
      case 'LogicalExpression':
      case 'ConditionalExpression':
      case 'UnaryExpression':
      case 'ParenthesizedExpression':
      case 'TSAsExpression':
      case 'TSSatisfiesExpression':
      case 'TSNonNullExpression':
        current = parentOf(current);
        continue;
      default:
        return null;
    }
  }
  return null;
}

/** Effect-native rule: instants come from `DateTime`/`Clock`, intervals from `Duration`. */
export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit A2/B5/B2: `new Date`, `Date.now`, `performance.now`, `getTime`/`toISOString`/`setHours`-style calls and hand-written millisecond arithmetic bypass Clock, DateTime, Duration and Schema.DateTimeUtc.',
      url: 'docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md#a2-make-schema-the-sole-authority-for-contracts-and-domain-models',
    },
    messages: {
      ambientDateConstruction:
        'Audit A2/B5: `{{expression}}` constructs a native Date. Use DateTime.now (or DateTime.nowAsDate at a driver edge) for the current instant, and an appropriate DateTime/Schema codec for deterministic parsing or calendar construction. Keep required Date representations at persistence/transport boundaries; deterministic fixture instants do not need TestClock control.',
      ambientClockRead:
        'Audit A2/B5/B2: `{{expression}}` uses a native clock or temporal conversion. Use `DateTime.now` / `Clock.currentTimeMillis` for live instants, DateTime/Schema codecs for deterministic parsing or calendar construction, and Duration + Effect.timed/Metric for elapsed time. Only live clock reads need TestClock control; cache-busting nonces should use Random/randomUUID.',
      dateMethodCall:
        'Audit A2/B5: `{{expression}}` hand-serialises or hand-calculates a timestamp on a `Date`. Encode through `Schema.DateTimeUtc` / `Schema.DateTimeUtcFromDate` instead of `.toISOString()`, and use `DateTime.add`/`DateTime.subtract`/`DateTime.toEpochMillis`/`DateTime.toParts` instead of `getTime()` and `set*`/`get*` calendar arithmetic.',
      handDurationArithmetic:
        'Audit B5: `{{expression}}` spells a duration out as magic millisecond arithmetic. Use `Duration.seconds`/`Duration.minutes`/`Duration.hours`/`Duration.days` (and `Duration.toMillis` only at the driver edge), so timeouts, TTLs, leases and backoffs stay typed and `TestClock`-controllable.',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          testMode: {
            type: 'string',
            enum: ['clock-only', 'all', 'off'],
            description:
              "How test files are handled: 'clock-only' (default) reports only ambient wall-clock reads, 'all' applies the production rules, 'off' skips tests.",
          },
          dateMethods: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Method names treated as hand Date serialisation / calendar arithmetic (default: getTime, toISOString, setDate, setUTCDate, setHours, setUTCHours, setMonth, setFullYear, getFullYear, getMonth, getDate, getHours, getTimezoneOffset).',
          },
          allowDurationArithmetic: {
            type: 'boolean',
            description:
              'Allow hand millisecond arithmetic in duration-named bindings (default: false).',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Globs of files exempted from this rule (default: none).',
          },
          ignoreScripts: {
            type: 'boolean',
            description: 'Skip scripts/** entirely (default: false).',
          },
          includePaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs the rule applies to (default: apps/**, verticals/**, packages/**, scripts/**).',
          },
          testPaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs force-treated as test files, overriding the built-in test-file detection.',
          },
          productionPaths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs force-treated as production files even when the built-in test-file detection matches.',
          },
          ignoreReceivers: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Receiver expressions whose date-named method calls are ignored (default: ["this", "super"]).',
          },
          browserEvaluatedMethods: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Callee names whose function arguments run inside a browser page and therefore have no Effect-native clock (default: ["evaluate", "evaluateHandle", "evaluateOnNewDocument", "waitForFunction", "addInitScript", "$eval", "$$eval"]).',
          },
        },
      },
    ],
    defaultOptions: [
      {
        testMode: 'clock-only',
        dateMethods: [...DEFAULT_DATE_METHODS],
        allowDurationArithmetic: false,
        ignore: [],
        ignoreScripts: false,
        includePaths: [...DEFAULT_INCLUDE_PATHS],
        testPaths: [],
        productionPaths: [],
        ignoreReceivers: ['this', 'super'],
        browserEvaluatedMethods: [...DEFAULT_BROWSER_EVALUATED_METHODS],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0]);
    const filename = normalisePath(context.filename).replace(FIXTURE_PREFIX, '');
    if (!matchesAny(filename, options.includePaths)) return {};
    if (matchesAny(filename, options.ignore)) return {};
    if (options.ignoreScripts && isScriptFile(filename)) return {};

    const inTest = matchesAny(filename, options.testPaths)
      ? true
      : matchesAny(filename, options.productionPaths)
        ? false
        : isTestFile(filename);
    if (inTest && options.testMode === 'off') return {};
    /** `clock-only`: report just the wall-clock reads `TestClock` must own. */
    const clockOnly = inTest && options.testMode === 'clock-only';

    const dateMethods = new Set(options.dateMethods);
    const ignoreReceivers = new Set(options.ignoreReceivers);
    const browserEvaluated = new Set(options.browserEvaluatedMethods);
    const clockTable = clockOnly ? TEST_CLOCK_MEMBERS : CLOCK_MEMBERS;
    let bindings: EffectBindings = { namespaces: new Map(), importsEffect: false };
    /** Spans already reported, so one expression never emits two overlapping diagnostics. */
    const reported = new Set<AnyNode>();

    /** Printed source, collapsed to one line and clipped so diagnostics stay readable. */
    const printed = (node: AnyNode): string => {
      const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
      return text.length > 72 ? `${text.slice(0, 69)}...` : text;
    };

    /**
     * `true` when the node sits inside a function body that a driver serialises and runs inside a
     * browser page (`page.evaluate`, `page.waitForFunction`, …). D tier: no Effect clock exists there.
     */
    const isBrowserEvaluated = (node: AnyNode): boolean => {
      let current: AnyNode | null = node;
      for (let depth = 0; current !== null && depth < 40; depth += 1) {
        if (FUNCTION_TYPES.has(current.type)) {
          const parent = parentOf(current);
          if (parent !== null && parent.type === 'CallExpression') {
            const call = parent as ESTree.CallExpression;
            const isArgument = (call.arguments as readonly AnyNode[]).includes(current);
            const callee = unwrap(call.callee as AnyNode, 0);
            if (isArgument && callee.type === 'MemberExpression') {
              const name = staticPropertyName(callee as ESTree.MemberExpression);
              if (name !== null && browserEvaluated.has(name)) return true;
            }
          }
        }
        current = parentOf(current);
      }
      return false;
    };

    const report = (node: AnyNode, messageId: string): void => {
      if (reported.has(node)) return;
      if (isBrowserEvaluated(node)) return;
      reported.add(node);
      context.report({ node, messageId, data: { expression: printed(node) } });
    };

    /** Resolve only explicit same-file type syntax; no inferred or cross-file receiver types. */
    const resolveType = (type: ESTree.TSType, depth = 0): ESTree.Node | null => {
      if (depth > 12) return null;
      if (type.type === 'TSParenthesizedType') return resolveType(type.typeAnnotation, depth + 1);
      if (type.type !== 'TSTypeReference' || type.typeName.type !== 'Identifier') return type;
      const variable = resolveVariable(context, type.typeName.name, type.typeName);
      const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      if (definition === undefined) return type;
      if (definition.node.type === 'TSTypeAliasDeclaration') {
        if (definition.node.typeParameters != null) return null;
        return resolveType(definition.node.typeAnnotation, depth + 1);
      }
      if (definition.node.type === 'TSInterfaceDeclaration') return definition.node.body;
      return null;
    };

    const declaredType = (raw: AnyNode, depth = 0): ESTree.TSType | null => {
      if (depth > 12) return null;
      if (
        raw.type === 'TSAsExpression' ||
        raw.type === 'TSSatisfiesExpression' ||
        raw.type === 'TSTypeAssertion'
      )
        return raw.typeAnnotation;
      const node = unwrap(raw, 0);
      const annotation = (node as { typeAnnotation?: ESTree.TSTypeAnnotation }).typeAnnotation;
      if (annotation?.type === 'TSTypeAnnotation') return annotation.typeAnnotation;
      if (node.type === 'Identifier') {
        const variable = resolveVariable(context, node.name, node);
        if (variable?.references.some((reference) => reference.isWrite() && !reference.init))
          return null;
        const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
        if (definition === undefined) return null;
        const declared = (definition.name as { typeAnnotation?: ESTree.TSTypeAnnotation })
          .typeAnnotation;
        if (declared != null) return declared.typeAnnotation;
        if (definition.node.type === 'VariableDeclarator' && definition.node.init !== null)
          return declaredType(definition.node.init, depth + 1);
      }
      if (node.type === 'MemberExpression') {
        const name = staticPropertyName(node);
        const owner = declaredType(node.object, depth + 1);
        const resolved = owner === null ? null : resolveType(owner);
        const members =
          resolved?.type === 'TSTypeLiteral'
            ? resolved.members
            : resolved?.type === 'TSInterfaceBody'
              ? resolved.body
              : [];
        for (const member of members) {
          if (member.type === 'TSPropertySignature' && keyName(member.key) === name)
            return member.typeAnnotation?.typeAnnotation ?? null;
        }
      }
      return null;
    };

    const isDateReceiver = (raw: AnyNode, depth = 0): boolean => {
      if (depth > 12) return false;
      const type = declaredType(raw);
      const resolved = type === null ? null : resolveType(type);
      if (
        resolved?.type === 'TSTypeReference' &&
        resolved.typeName.type === 'Identifier' &&
        resolved.typeName.name === 'Date'
      ) {
        return resolveGlobalName(context, resolved.typeName) === 'Date';
      }
      const node = unwrap(raw, 0);
      if (node.type === 'NewExpression') return resolveGlobalName(context, node.callee) === 'Date';
      if (node.type === 'MemberExpression' && staticPropertyName(node) === 'prototype')
        return resolveGlobalName(context, node.object) === 'Date';
      if (node.type !== 'Identifier') return false;
      const variable = resolveVariable(context, node.name, node);
      if (variable?.references.some((reference) => reference.isWrite() && !reference.init))
        return false;
      const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
      return (
        definition?.node.type === 'VariableDeclarator' &&
        definition.node.init !== null &&
        isDateReceiver(definition.node.init, depth + 1)
      );
    };

    /**
     * `true` when this expression is the receiver of a `dateMethods` member that will itself be
     * reported — `new Date(x).toISOString()` is one finding, not two.
     */
    const isReportedDateMethodReceiver = (node: AnyNode): boolean => {
      if (clockOnly) return false;
      const { node: reference, parent } = skipWrappers(node);
      if (parent === null || parent.type !== 'MemberExpression') return false;
      const member = parent as ESTree.MemberExpression;
      if ((member.object as AnyNode) !== reference) return false;
      const name = staticPropertyName(member);
      return name !== null && dateMethods.has(name);
    };

    return {
      Program(node) {
        bindings = collectEffectBindings(node);
      },

      // (1) `new Date(...)` — in tests under `clock-only`, only the zero-argument wall-clock read.
      NewExpression(node) {
        if (resolveGlobalName(context, node.callee as AnyNode) !== 'Date') return;
        if (clockOnly && node.arguments.length > 0) return;
        if (isReportedDateMethodReceiver(node as unknown as AnyNode)) return;
        report(node as unknown as AnyNode, 'ambientDateConstruction');
      },

      // (2) ambient clock members and (3) hand `Date` serialisation / calendar arithmetic.
      // Both live on `MemberExpression` so point-free references (`const f = at.toISOString`)
      // and computed/template keys are covered, not only direct calls.
      MemberExpression(node) {
        const member = staticPropertyName(node);
        if (member === null) return;

        // (2) `Date.now` / `Date.parse` / `Date.UTC` / `performance.now` / `process.hrtime[.bigint]`,
        // including `globalThis.`-qualified and locally aliased forms.
        const global = resolveGlobalName(context, node.object as AnyNode);
        if (global !== null) {
          const members = clockTable.get(global);
          if (members !== undefined && members.has(member)) {
            // `process.hrtime.bigint()` reports once, on the outer call.
            let site: AnyNode = node as unknown as AnyNode;
            if (global === 'process') {
              const outer = skipWrappers(site);
              if (
                outer.parent !== null &&
                outer.parent.type === 'MemberExpression' &&
                (outer.parent as ESTree.MemberExpression).object === outer.node &&
                staticPropertyName(outer.parent as ESTree.MemberExpression) === 'bigint'
              ) {
                site = outer.parent;
              }
            }
            report(callSiteOf(site), 'ambientClockRead');
            return;
          }
        }

        // (3) hand serialisation / hand calendar arithmetic on a `Date` receiver.
        if (clockOnly) return;
        if (!dateMethods.has(member)) return;
        const receiver = unwrap(node.object as AnyNode, 0);
        if (receiver.type === 'ThisExpression' && ignoreReceivers.has('this')) return;
        if (receiver.type === 'Super' && ignoreReceivers.has('super')) return;
        if (receiver.type === 'Identifier') {
          const receiverName = (receiver as ESTree.IdentifierReference).name;
          if (ignoreReceivers.has(receiverName)) return;
          // Effect's own temporal/schema API is never a hand-rolled `Date` call.
          if (bindings.namespaces.has(receiverName)) return;
        }
        if (!isDateReceiver(node.object)) return;
        report(callSiteOf(node as unknown as AnyNode), 'dateMethodCall');
      },

      // (2b) `const { now } = Date` / `const { now: elapsedNow } = performance` — destructuring the
      // member off the global hides the wall-clock read from the member-expression handler.
      VariableDeclarator(node) {
        const id = node.id as AnyNode;
        if (id.type !== 'ObjectPattern') return;
        const init = (node.init ?? null) as AnyNode | null;
        if (init === null) return;
        const global = resolveGlobalName(context, init);
        if (global === null) return;
        const members = clockTable.get(global);
        if (members === undefined) return;
        for (const property of (id as ESTree.ObjectPattern).properties as readonly AnyNode[]) {
          if (property.type !== 'Property') continue;
          const key = (property as { key: AnyNode; computed: boolean }).key;
          const name = (property as { computed: boolean }).computed ? null : keyName(key);
          if (name !== null && members.has(name)) report(property, 'ambientClockRead');
        }
      },

      // (4) a Duration spelled out as magic millisecond arithmetic.
      BinaryExpression(node) {
        if (clockOnly || options.allowDurationArithmetic) return;
        if (node.operator !== '*' && node.operator !== '/') return;
        const site = node as unknown as AnyNode;
        if (isInsideDurationChain(site)) return;
        if (!containsDurationLiteral(site, 0)) return;
        if (isEffectCallArgument(site, bindings)) return;
        const owner = ownerName(site);
        const owned = owner !== null && DURATION_NAME.test(owner);
        // Without an owning name, only a multiplication *up* to milliseconds is a hand-rolled
        // Duration; a division is normally a unit conversion at an edge (`Math.floor(ms / 1000)`).
        const named = owned || (node.operator === '*' && operandDurationName(site, 0) !== null);
        if (!named) return;
        report(site, 'handDurationArithmetic');
      },
    };
  },
});
