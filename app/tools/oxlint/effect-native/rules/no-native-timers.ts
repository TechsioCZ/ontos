/**
 * effect-native/no-native-timers
 *
 * Audit findings enforced (docs/architecture/EFFECT_V4_ANTIPATTERN_AUDIT.md):
 *   - **B1** "Make workers and independent reads declaratively concurrent" — "the outbox uses
 *     fixed-interval imperative polling; database and SpiceDB operations lack consistent typed
 *     timeout/retry policy. Use `Stream`, `Schedule`, bounded `Effect.forEach`/`Effect.all`, typed
 *     retry schedules, explicit timeouts, and interruption-aware worker scopes." A native
 *     `setTimeout`/`setInterval` is precisely the imperative, non-interruptible, Clock-less form of
 *     that policy: the timer keeps running after the fiber is interrupted, and its handle has to be
 *     cleared by hand.
 *   - **B2** "Build one Effect-aware testing harness" — "≈642 `Effect.runPromise` calls in tests,
 *     **real sleeps/timers**". Tests that race a native timer against an Effect sleep are wall-clock
 *     bound and flaky; the same tests that use Effect time operators without installing `TestClock`
 *     burn real seconds. This rule owns both halves (the merged `no-real-time-in-tests` scope).
 *
 * ## What is detected
 *
 *   1. `nativeTimerCall` — a value reference to an unshadowed global timer function: `setTimeout`,
 *      `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`,
 *      `queueMicrotask`. Bare (`setTimeout(fn, ms)`) and namespaced (`globalThis.setTimeout`,
 *      `window.setTimeout`, `global.setImmediate`, `self.queueMicrotask`) forms, including optional
 *      chaining (`window?.setTimeout(...)`) and computed access (`globalThis["setTimeout"]`).
 *   2. `timerModuleImport` — a *value* import, re-export or static dynamic import/require from `node:timers`, `timers`,
 *      `node:timers/promises` or `timers/promises`.
 *   3. `timerBindingCall` — every call of a binding introduced by such an import, including aliases
 *      (`import { setTimeout as delay } from "node:timers/promises"; await delay(50)`) and
 *      namespace imports (`import * as timers from "node:timers"; timers.setInterval(...)`).
 *   4. `realTimeInTest` — in test files only, and only when the file installs no `TestClock`:
 *      Effect time operators (`Effect.sleep`, `Effect.delay`, `Effect.timeout*`, `Effect.schedule`,
 *      `Effect.repeat*`, `Effect.retry*`), any `Schedule.*` member, `Clock.currentTimeMillis` /
 *      `Clock.currentTimeNanos` / `Clock.sleep`, and `DateTime.now` / `DateTime.unsafeNow`. Aliased
 *      (`import { Effect as E } from "effect"`) and submodule namespace imports
 *      (`import * as Schedule from "effect/Schedule"`) resolve identically through the shared
 *      binding collector; direct function imports (`import { sleep } from "effect/Effect"`) report
 *      on the specifier.
 *
 * ## What is deliberately allowed
 *
 *   - **D tier — "Promise adapters forced by React, TanStack, Modern.js, Playwright, Drizzle, and
 *     Node process entrypoints."** Playwright/e2e specs are ignored by default (`ignore`), and a
 *     single outer framework adapter can be listed in `adapterFiles`.
 *   - `node:test` virtual timers: a file that calls `mock.timers.enable(...)` already owns
 *     deterministic time, so its native timer calls are not reported (`allowNodeTestMockTimers`).
 *   - A file with value-import evidence of `TestClock` from `effect/testing`,
 *     or an explicitly configured imported harness in `testClockIndicators`, keeps its
 *     Effect time operators — that is the target pattern, not the anti-pattern.
 *   - Effect time operators in **production** code: `Effect.repeat(Schedule.spaced(...))` and
 *     `Effect.timeout` are exactly what B1 asks for, so they are only questioned inside tests.
 *   - Locally shadowed or non-timer bindings: a parameter named `setTimeout`, a test double
 *     `const setTimeout = () => {}`, `clock.setTimeout(...)` on an injected service, and
 *     `scheduler.setInterval` are all left alone.
 *   - `scripts/**` is out of scope by default (`includeScripts: false`) — B3 migrates scripts on its
 *     own schedule.
 *
 * TestClock evidence is file-level only; import presence cannot prove provisioning or execution.
 * Dynamic property names, dynamic module specifiers and arbitrary adapter data-flow are not inferred.
 * Report-only: no fixer, no suggestion. Existing violations are the intended output.
 */
import { defineRule } from '@oxlint/plugins';

import type { Context, ESTree, Scope } from '@oxlint/plugins';

import { collectEffectBindings, effectMember } from '../shared/effect-imports.ts';
import type { EffectBindings } from '../shared/effect-imports.ts';
import { isScriptFile, isTestFile, matchesAny } from '../shared/paths.ts';

type AnyNode = ESTree.Node;

/** Global timer functions that escape `Clock` and survive fiber interruption. */
const DEFAULT_TIMER_GLOBALS: readonly string[] = [
  'setTimeout',
  'setInterval',
  'setImmediate',
  'clearTimeout',
  'clearInterval',
  'clearImmediate',
  'queueMicrotask',
];

/** Objects that hand out the same global timers under a member access. */
const DEFAULT_GLOBAL_OBJECTS: readonly string[] = ['globalThis', 'window', 'global', 'self'];

/** Node timer modules; importing any of them is already the anti-pattern. */
const DEFAULT_TIMER_MODULES: readonly string[] = [
  'node:timers',
  'timers',
  'node:timers/promises',
  'timers/promises',
];

/** `Effect.*` operators whose behaviour is defined by the ambient `Clock`. */
const DEFAULT_EFFECT_TIME_MEMBERS: readonly string[] = [
  'sleep',
  'delay',
  'timeout',
  'timeoutFail',
  'timeoutOption',
  'timeoutOrElse',
  'timeoutTo',
  'schedule',
  'scheduleForked',
  'repeat',
  'repeatOrElse',
  'retry',
  'retryOrElse',
];

const DEFAULT_CLOCK_MEMBERS: readonly string[] = ['currentTimeMillis', 'currentTimeNanos', 'sleep'];

const DEFAULT_DATE_TIME_MEMBERS: readonly string[] = ['now', 'unsafeNow', 'nowUnsafe'];

/** Identifier names that prove the file drives virtual time. */
const DEFAULT_TEST_CLOCK_INDICATORS: readonly string[] = ['TestClock'];

const DEFAULT_INCLUDE_PATHS: readonly string[] = [
  'apps/**',
  'verticals/**',
  'packages/**',
  'scripts/**',
];

/** D tier: Promise/timer adapters forced by Playwright and other browser drivers. */
const DEFAULT_IGNORE_PATHS: readonly string[] = [
  '**/tests/e2e/**',
  '**/*.e2e.*',
  '**/playwright/**',
];

/** `effect/Effect`-style submodules whose named exports are the time operators themselves. */
const SUBMODULE_SOURCE = /^effect\/(Effect|Schedule|Clock|DateTime)$/u;

/** Marker stored in `timerBindings` for `import * as timers from "node:timers"`. */
const NAMESPACE_BINDING = '*';

interface RuleOptions {
  readonly includeTests?: boolean;
  readonly includeScripts?: boolean;
  readonly requireTestClockInTests?: boolean;
  readonly allowNodeTestMockTimers?: boolean;
  readonly adapterFiles?: readonly string[];
  readonly ignore?: readonly string[];
  readonly includePaths?: readonly string[];
  readonly testPaths?: readonly string[];
  readonly productionPaths?: readonly string[];
  readonly timerGlobals?: readonly string[];
  readonly globalObjects?: readonly string[];
  readonly timerModules?: readonly string[];
  readonly effectTimeMembers?: readonly string[];
  readonly clockMembers?: readonly string[];
  readonly dateTimeMembers?: readonly string[];
  readonly testClockIndicators?: readonly string[];
}

function readOptions(raw: RuleOptions | undefined): Required<RuleOptions> {
  const value = raw ?? {};
  return {
    includeTests: value.includeTests ?? true,
    includeScripts: value.includeScripts ?? false,
    requireTestClockInTests: value.requireTestClockInTests ?? true,
    allowNodeTestMockTimers: value.allowNodeTestMockTimers ?? true,
    adapterFiles: value.adapterFiles ?? [],
    ignore: value.ignore ?? DEFAULT_IGNORE_PATHS,
    includePaths: value.includePaths ?? DEFAULT_INCLUDE_PATHS,
    testPaths: value.testPaths ?? [],
    productionPaths: value.productionPaths ?? [],
    timerGlobals: value.timerGlobals ?? DEFAULT_TIMER_GLOBALS,
    globalObjects: value.globalObjects ?? DEFAULT_GLOBAL_OBJECTS,
    timerModules: value.timerModules ?? DEFAULT_TIMER_MODULES,
    effectTimeMembers: value.effectTimeMembers ?? DEFAULT_EFFECT_TIME_MEMBERS,
    clockMembers: value.clockMembers ?? DEFAULT_CLOCK_MEMBERS,
    dateTimeMembers: value.dateTimeMembers ?? DEFAULT_DATE_TIME_MEMBERS,
    testClockIndicators: value.testClockIndicators ?? DEFAULT_TEST_CLOCK_INDICATORS,
  };
}

interface Site {
  readonly node: AnyNode;
  readonly callee: string;
}

/** Static string key of a member/property node, or `null` when it is dynamic. */
function staticKey(node: AnyNode, computed: boolean): string | null {
  if (!computed && node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? null;
  return null;
}

/** Strip `ChainExpression` / `ParenthesizedExpression` wrappers so `(window)?.setTimeout` still matches. */
function unwrap(node: AnyNode): AnyNode {
  let current = node;
  while (
    [
      'ChainExpression',
      'ParenthesizedExpression',
      'TSAsExpression',
      'TSTypeAssertion',
      'TSNonNullExpression',
      'TSSatisfiesExpression',
      'TSInstantiationExpression',
    ].includes(current.type)
  ) {
    current = (current as unknown as { expression: AnyNode }).expression;
  }
  return current;
}

type Resolution = 'global' | 'import' | 'shadowed';

/**
 * Classify an identifier reference: an unshadowed global, a module import binding, or a local
 * shadow (parameter, `const`, function, catch binding, class name).
 */
function resolve(context: Context, node: AnyNode, name: string): Resolution {
  let scope: Scope | null = context.sourceCode.getScope(node);
  while (scope !== null) {
    const variable = scope.set.get(name);
    if (variable !== undefined) {
      if (variable.defs.length === 0) return 'global';
      if (variable.defs.some((definition) => definition.type === 'ImportBinding')) return 'import';
      if (variable.defs.every((definition) => definition.type === 'ImplicitGlobalVariable'))
        return 'global';
      return 'shadowed';
    }
    scope = scope.upper;
  }
  return 'global';
}

export const rule = defineRule({
  meta: {
    type: 'problem',
    docs: {
      description:
        'Audit B1 + B2: no native timers. `setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask` and ' +
        'the `node:timers` modules escape the Effect `Clock`, ignore interruption and force hand-cleared ' +
        'handles; use `Effect.sleep`, `Effect.timeout`/`timeoutOrElse` and ' +
        '`Effect.repeat(Schedule.spaced(...))` instead. In tests, Effect time operators additionally ' +
        'require visible `TestClock` evidence; file-level presence does not prove clock provisioning.',
    },
    messages: {
      nativeTimerCall:
        'Native timer `{{callee}}` bypasses the Effect Clock and interruption. Use Effect.sleep/' +
        'Effect.timeout/Effect.timeoutOrElse, Effect.repeat(Schedule.spaced(...)) inside an ' +
        'interruption-aware scope, and drive tests with TestClock.adjust from effect/testing.',
      timerModuleImport:
        'Importing "{{callee}}" pulls Node timers into an Effect program: those sleeps are outside the ' +
        'Effect Clock and are not interrupted with the fiber. Use Effect.sleep / Effect.timeout / ' +
        'Effect.repeat(Schedule.spaced(...)), and TestClock.adjust from effect/testing in tests.',
      timerBindingCall:
        'Native timer `{{callee}}` (imported from a Node timers module) bypasses the Effect Clock and ' +
        'interruption. Use Effect.sleep/Effect.timeout/Effect.timeoutOrElse and ' +
        'Effect.repeat(Schedule.spaced(...)) instead.',
      realTimeInTest:
        '`{{callee}}` uses time/scheduling APIs without visible TestClock evidence in this test file. ' +
        'Provide TestClock.layer() and adjust virtual time when testing Effect timing. ' +
        'This file-level heuristic cannot prove clock provisioning or whether a schedule actually delays.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          includeTests: {
            type: 'boolean',
            description: 'Apply the rule to test files (default: true).',
          },
          includeScripts: {
            type: 'boolean',
            description: 'Apply the rule to scripts/** (default: false — B3 owns scripts).',
          },
          requireTestClockInTests: {
            type: 'boolean',
            description:
              'Report Effect time operators (Effect.sleep, Schedule.*, Clock.*, DateTime.now) in test ' +
              'files that install no TestClock (default: true).',
          },
          allowNodeTestMockTimers: {
            type: 'boolean',
            description:
              'Allow native timers in a file that calls `mock.timers.enable(...)` from node:test ' +
              '(default: true).',
          },
          adapterFiles: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs of the single outer process/framework adapter files allowed to own native timers ' +
              '(default: none).',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Globs exempted from this rule (default: **/tests/e2e/**, **/*.e2e.*, **/playwright/**).',
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
          timerGlobals: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Global timer function names (default: setTimeout, setInterval, setImmediate, clearTimeout, ' +
              'clearInterval, clearImmediate, queueMicrotask).',
          },
          globalObjects: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Objects that expose the timer globals (default: globalThis, window, global, self).',
          },
          timerModules: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Modules whose value imports are timers (default: node:timers, timers, node:timers/promises, ' +
              'timers/promises).',
          },
          effectTimeMembers: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Effect members that depend on the ambient Clock (default: sleep, delay, timeout*, schedule, repeat*, retry*).',
          },
          clockMembers: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Clock members treated as real-time reads (default: currentTimeMillis, currentTimeNanos, sleep).',
          },
          dateTimeMembers: {
            type: 'array',
            items: { type: 'string' },
            description:
              'DateTime members treated as real-time reads (default: now, unsafeNow, nowUnsafe).',
          },
          testClockIndicators: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Identifier names proving the file drives virtual time (default: TestClock). Add a repository ' +
              'harness name here once it always provides TestClock.',
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [
      {
        includeTests: true,
        includeScripts: false,
        requireTestClockInTests: true,
        allowNodeTestMockTimers: true,
        adapterFiles: [],
        ignore: [...DEFAULT_IGNORE_PATHS],
        includePaths: [...DEFAULT_INCLUDE_PATHS],
        testPaths: [],
        productionPaths: [],
        timerGlobals: [...DEFAULT_TIMER_GLOBALS],
        globalObjects: [...DEFAULT_GLOBAL_OBJECTS],
        timerModules: [...DEFAULT_TIMER_MODULES],
        effectTimeMembers: [...DEFAULT_EFFECT_TIME_MEMBERS],
        clockMembers: [...DEFAULT_CLOCK_MEMBERS],
        dateTimeMembers: [...DEFAULT_DATE_TIME_MEMBERS],
        testClockIndicators: [...DEFAULT_TEST_CLOCK_INDICATORS],
      },
    ],
  },
  create(context) {
    const options = readOptions(context.options[0] as RuleOptions | undefined);
    const filename = context.filename;
    if (!matchesAny(filename, options.includePaths)) return {};
    if (matchesAny(filename, options.ignore)) return {};
    if (matchesAny(filename, options.adapterFiles)) return {};
    if (isScriptFile(filename) && !options.includeScripts) return {};

    const inTest = matchesAny(filename, options.testPaths)
      ? true
      : matchesAny(filename, options.productionPaths)
        ? false
        : isTestFile(filename);
    if (inTest && !options.includeTests) return {};

    const timerGlobals = new Set(options.timerGlobals);
    const globalObjects = new Set(options.globalObjects);
    const timerModules = new Set(options.timerModules);
    const effectTimeMembers = new Set(options.effectTimeMembers);
    const clockMembers = new Set(options.clockMembers);
    const dateTimeMembers = new Set(options.dateTimeMembers);
    const testClockIndicators = new Set(options.testClockIndicators);
    const checkEffectTime = inTest && options.requireTestClockInTests;

    /** local name → imported timer member, or `*` for a namespace import. */
    const timerBindings = new Map<string, string>();
    let bindings: EffectBindings = { namespaces: new Map(), importsEffect: false };
    let hasTestClock = false;
    let hasMockTimers = false;
    const testingNamespaces = new Set<string>();
    const nodeTestMocks = new Set<string>();

    const nativeSites: Site[] = [];
    const bindingSites: Site[] = [];
    const importSites: Site[] = [];
    const timeSites: Site[] = [];

    /** Printed source, collapsed to one line and clipped so diagnostics stay readable. */
    const printed = (node: AnyNode): string => {
      const text = context.sourceCode.getText(node).replace(/\s+/gu, ' ').trim();
      return text.length > 60 ? `${text.slice(0, 57)}...` : text;
    };

    /** `Effect.sleep` / `E["sleep"]` / `Schedule?.spaced` → the effect namespace + member. */
    function timeMemberOf(
      node: ESTree.MemberExpression,
    ): { namespace: string; member: string } | null {
      const object = unwrap(node.object);
      if (object.type !== 'Identifier' || resolve(context, object, object.name) !== 'import')
        return null;
      const namespace = bindings.namespaces.get(object.name);
      if (namespace === undefined) return null;
      const member = staticKey(node.property, node.computed);
      return member === null ? null : { namespace, member };
    }

    function isRealTimeMember(namespace: string, member: string): boolean {
      if (namespace === 'Effect') return effectTimeMembers.has(member);
      if (namespace === 'Schedule') return true;
      if (namespace === 'Clock') return clockMembers.has(member);
      if (namespace === 'DateTime') return dateTimeMembers.has(member);
      return false;
    }

    return {
      Program(node) {
        bindings = collectEffectBindings(node);
      },
      Identifier(node) {
        if (!timerGlobals.has(node.name) || resolve(context, node, node.name) !== 'global') return;
        let parent: ESTree.Node | null = node.parent;
        while (parent !== null && parent !== undefined) {
          if (
            ['TSTypeQuery', 'TSTypeReference', 'TSQualifiedName', 'TSTypeAnnotation'].includes(
              parent.type,
            )
          )
            return;
          parent = parent.parent;
        }
        // Scope references exclude declarations, labels and noncomputed keys; type queries above
        // also have scope references but must not be treated as runtime captures.
        const scope = context.sourceCode.getScope(node);
        if (scope.references.some((reference) => reference.identifier === node)) {
          nativeSites.push({ node, callee: node.name });
        }
      },
      ImportExpression(node) {
        const source = staticKey(node.source, true);
        if (source !== null && timerModules.has(source)) importSites.push({ node, callee: source });
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type' || node.source === null) return;
        if (
          node.specifiers.length > 0 &&
          node.specifiers.every((specifier) => specifier.exportKind === 'type')
        )
          return;
        const source = node.source.value;
        if (timerModules.has(source)) importSites.push({ node, callee: source });
      },
      ExportAllDeclaration(node) {
        if (node.exportKind !== 'type' && timerModules.has(node.source.value))
          importSites.push({ node, callee: node.source.value });
      },

      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        const source = node.source.value;
        const values = node.specifiers.filter(
          (specifier) => specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type',
        );
        if (node.specifiers.length > 0 && values.length === 0) return;
        for (const specifier of values) {
          if (specifier.type === 'ImportNamespaceSpecifier' && source === 'effect/testing')
            testingNamespaces.add(specifier.local.name);
          if (specifier.type !== 'ImportSpecifier') continue;
          const imported =
            specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : specifier.imported.value;
          if (source === 'effect/testing' && imported === 'TestClock') hasTestClock = true;
          if (testClockIndicators.has(imported) && imported !== 'TestClock') hasTestClock = true;
          if (source === 'node:test' && imported === 'mock')
            nodeTestMocks.add(specifier.local.name);
        }
        if (timerModules.has(source)) {
          importSites.push({ node, callee: source });
          for (const specifier of node.specifiers) {
            if (
              specifier.type === 'ImportNamespaceSpecifier' ||
              specifier.type === 'ImportDefaultSpecifier'
            ) {
              timerBindings.set(specifier.local.name, NAMESPACE_BINDING);
              continue;
            }
            if (specifier.type !== 'ImportSpecifier') continue;
            if (specifier.importKind === 'type') continue;
            const imported =
              specifier.imported.type === 'Identifier'
                ? specifier.imported.name
                : specifier.imported.value;
            timerBindings.set(specifier.local.name, imported);
          }
          return;
        }
        if (!checkEffectTime) return;
        const submodule = SUBMODULE_SOURCE.exec(source)?.[1];
        if (submodule === undefined) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue;
          if (specifier.importKind === 'type') continue;
          const imported =
            specifier.imported.type === 'Identifier'
              ? specifier.imported.name
              : specifier.imported.value;
          if (!isRealTimeMember(submodule, imported)) continue;
          timeSites.push({ node: specifier, callee: `${submodule}.${imported}` });
        }
      },

      CallExpression(node) {
        const callee = unwrap(node.callee);

        if (callee.type === 'Identifier') {
          const name = callee.name;
          const resolution = resolve(context, callee, name);
          if (resolution === 'import') {
            if (timerBindings.has(name)) bindingSites.push({ node: callee, callee: name });
            return;
          }
          if (resolution === 'global' && name === 'require' && node.arguments[0] !== undefined) {
            const source = staticKey(node.arguments[0], true);
            if (source !== null && timerModules.has(source))
              importSites.push({ node, callee: source });
          }
          return;
        }

        if (callee.type !== 'MemberExpression') return;
        let object = unwrap(callee.object);
        const member = staticKey(callee.property, callee.computed);
        if (member === null) return;

        // Only a real node:test mock binding may provide virtual native timers.
        if (
          object.type === 'MemberExpression' &&
          staticKey(object.property, object.computed) === 'timers'
        ) {
          const root = unwrap(object.object);
          if (
            root.type === 'Identifier' &&
            nodeTestMocks.has(root.name) &&
            resolve(context, root, root.name) === 'import' &&
            member === 'enable'
          )
            hasMockTimers = true;
        }
        const chain: string[] = [];
        while (object.type === 'MemberExpression') {
          const key = staticKey(object.property, object.computed);
          if (key === null) return;
          chain.push(key);
          object = unwrap(object.object);
        }

        if (object.type !== 'Identifier') return;
        const objectName = object.name;

        if (timerBindings.has(objectName) && resolve(context, object, objectName) === 'import') {
          bindingSites.push({ node: callee, callee: printed(callee) });
          return;
        }
      },

      MemberExpression(node) {
        let root = unwrap(node.object);
        const chain: string[] = [];
        while (root.type === 'MemberExpression') {
          const key = staticKey(root.property, root.computed);
          if (key === null) break;
          chain.push(key);
          root = unwrap(root.object);
        }
        if (
          root.type === 'Identifier' &&
          globalObjects.has(root.name) &&
          resolve(context, root, root.name) === 'global' &&
          timerGlobals.has(staticKey(node.property, node.computed) ?? '') &&
          chain.every((key) => globalObjects.has(key))
        )
          nativeSites.push({ node, callee: printed(node) });
        const object = unwrap(node.object);
        if (
          object.type === 'Identifier' &&
          testingNamespaces.has(object.name) &&
          staticKey(node.property, node.computed) === 'TestClock' &&
          resolve(context, object, object.name) === 'import'
        )
          hasTestClock = true;
        if (!checkEffectTime) return;
        const resolved = timeMemberOf(node);
        if (resolved === null) return;
        if (!isRealTimeMember(resolved.namespace, resolved.member)) return;
        if (
          node.object.type === 'Identifier' &&
          resolve(context, node.object, node.object.name) === 'shadowed'
        ) {
          return;
        }
        timeSites.push({ node, callee: printed(node) });
      },

      'Program:exit'() {
        const suppressNative = options.allowNodeTestMockTimers && hasMockTimers;
        if (!suppressNative) {
          for (const site of importSites) {
            context.report({
              node: site.node,
              messageId: 'timerModuleImport',
              data: { callee: site.callee },
            });
          }
          for (const site of nativeSites) {
            context.report({
              node: site.node,
              messageId: 'nativeTimerCall',
              data: { callee: site.callee },
            });
          }
          for (const site of bindingSites) {
            context.report({
              node: site.node,
              messageId: 'timerBindingCall',
              data: { callee: site.callee },
            });
          }
        }
        if (hasTestClock) return;
        for (const site of timeSites) {
          context.report({
            node: site.node,
            messageId: 'realTimeInTest',
            data: { callee: site.callee },
          });
        }
      },
    };
  },
});
