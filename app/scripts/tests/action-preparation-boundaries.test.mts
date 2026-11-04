import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Array as EffectArray, Effect, Order } from 'effect';
import { expect, it } from 'effect-rstest';
import { parseSync } from 'oxc-parser';

import { actionPreparationBoundaries } from '../action-preparation-boundaries.mts';
import { checkDatabaseAccessBoundaries } from '../check-database-access-boundaries.mts';

const serviceReadMethod = 'read: () => transaction.select()';
const serviceResult = `{ ${serviceReadMethod} }`;
const serviceReturn = `return ${serviceResult};`;
const helperInvocation = 'yield* make(transaction, { scope })';
const guardCheckResult = "value === 'human' ? Fx.void : Fx.fail(denied)";
const guardCheckInvocation = 'check(context.scope.authMethod)';
const guardedHandlerInvocation = 'handler(payload, context)';
const header = `import type { ActionServicePreflight as Preflight, ActionServiceFactory as Factory, ActionServicePreparationContext as Preparation, ScopedTransactionExecutor as Executor, OperationalScope as Scope } from '@app/core-runtime';
import { defineAction as register } from '@app/core-runtime';
import { Effect as Fx } from 'effect';
`;
const factory = `Fx.fn('commit')(function* commit(transaction: Executor, scope: Scope, revision: string) {
  return { read: () => transaction.select() };
})`;
const preflight = `Fx.fn('prepare')(function* prepare(payload, context: Preparation) {
  return ${factory};
})`;
const guard = `import { Effect as Fx } from 'effect';
const check = value => value === 'human' ? Fx.void : Fx.fail(denied);
const checkStorefront = value => Fx.succeed(value);
export const withCommandGuard = handler => (payload, context) =>
  check(context.scope.authMethod).pipe(Fx.flatMap(() => handler(payload, context)));
`;

interface PreparationCase {
  readonly expression: string;
  readonly guardSource?: string;
  readonly imports?: string;
  readonly suffix?: string;
}

const cases = {
  'invalid-counterfeit-error-transform': {
    expression: `Fx.fn('prepare')(function* prepare(payload, context: Preparation) { return ${factory}; }, Other.mapError(unavailable))`,
    imports: 'import { Effect as Other } from "foreign-effect";',
  },
  'invalid-counterfeit-guard': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(guardedHandlerInvocation, 'Fx.succeed({})'),
  },
  'invalid-cyclic-reexport-helper': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/invalid-cyclic-reexport-helper.ts";',
  },
  'invalid-error-recovery-transform': {
    expression: `Fx.fn('prepare')(function* prepare(payload, context: Preparation) { return ${factory}; }, Fx.catchAll(replaceFactory))`,
  },
  'invalid-escaping-helper': {
    expression: preflight.replace(
      serviceReturn,
      'const load = (raw: Executor) => raw.select(); return { load, current: () => load(transaction) };',
    ),
  },
  'invalid-guard-async': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace('= handler =>', '= async handler =>'),
  },
  'invalid-guard-callback-success-map': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(guardedHandlerInvocation, 'handler(payload, context).pipe(Fx.map(replaceFactory))'),
  },
  'invalid-guard-changed-context': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(guardedHandlerInvocation, 'handler(payload, { ...context, transaction: raw })'),
  },
  'invalid-guard-counterfeit-pipe': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(guardCheckResult, '({ pipe: () => replaceFactory })'),
  },
  'invalid-guard-creation-escape': {
    expression: `guarded(${preflight})`,
    guardSource: guard
      .replace('handler => (payload, context) =>', 'handler => { retain(handler); return (payload, context) =>')
      .replace('context)));', 'context))); };'),
  },
  'invalid-guard-cyclic-alias': {
    expression: `firstGuard(${preflight})`,
    imports: 'const firstGuard = secondGuard; const secondGuard = firstGuard;',
  },
  'invalid-guard-foreign-effect': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace("from 'effect'", "from 'foreign-effect'"),
  },
  'invalid-guard-handler-escape': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(guardCheckInvocation, 'retain(handler)'),
  },
  'invalid-guard-mutable-alias': {
    expression: `stableGuard(${preflight})`,
    guardSource: guard,
    imports: 'let stableGuard = guarded;',
  },
  'invalid-guard-mutable-export': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace('export const', 'export let'),
  },
  'invalid-guard-mutated-effect': {
    expression: `guarded(${preflight})`,
    guardSource: `${guard}\nFx.flatMap = counterfeit;`,
  },
  'invalid-guard-mutated-export': {
    expression: `guarded(${preflight})`,
    guardSource: `${guard}\nwithCommandGuard = counterfeit;`,
  },
  'invalid-guard-mutated-import': {
    expression: `guarded(${preflight})`,
    guardSource: guard,
    suffix: 'guarded = counterfeit;',
  },
  'invalid-guard-mutates-condition': {
    expression: `guarded(${preflight})`,
    guardSource: guard
      .replace("value === 'human'", '(value.transaction = raw)')
      .replace(guardCheckInvocation, 'check(context)'),
  },
  'invalid-guard-mutates-context-helper': {
    expression: `guarded(${preflight})`,
    guardSource: guard
      .replace(guardCheckResult, 'Fx.succeed(Object.assign(value, { transaction: raw }))')
      .replace(guardCheckInvocation, 'check(context)'),
  },
  'invalid-guard-mutates-payload-argument': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(guardCheckInvocation, 'check(Object.assign(payload, { tenantId: foreignTenant }))'),
  },
  'invalid-guard-recursive-check': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(guardCheckResult, 'check(value)'),
  },
  'invalid-guard-reordered-inputs': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(guardedHandlerInvocation, 'handler(context, payload)'),
  },
  'invalid-guard-shadowed-effect': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace('(payload, context)', '(payload, context, Fx)'),
  },
  'invalid-guard-shadowed-handler': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace('() => handler(payload, context)', '(handler) => handler(payload, context)'),
  },
  'invalid-guard-shadowed-import': {
    expression: `((guarded) => guarded(${preflight}))(otherGuard)`,
    guardSource: guard,
  },
  'invalid-guard-success-flatmap': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(
      'Fx.flatMap(() => handler(payload, context))',
      'Fx.flatMap(() => handler(payload, context)), Fx.flatMap(replaceFactory)',
    ),
  },
  'invalid-guard-success-map': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(
      'Fx.flatMap(() => handler(payload, context))',
      'Fx.flatMap(() => handler(payload, context)), Fx.map(replaceFactory)',
    ),
  },
  'invalid-guard-type-import': {
    expression: `guarded(${preflight})`,
    guardSource: guard,
    imports: 'import type { withCommandGuard as guarded } from "../../shared/invalid-guard-type-import.ts";',
  },
  'invalid-guard-unknown-check': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(
      "const check = value => value === 'human' ? Fx.void : Fx.fail(denied);",
      'import { check } from "foreign-guard";',
    ),
  },
  'invalid-guard-unresolved-import': {
    expression: `guarded(${preflight})`,
    imports: 'import { withCommandGuard as guarded } from "foreign-guard";',
  },
  'invalid-guarded-executor-input': {
    expression: `guarded(${preflight.replace(serviceReadMethod, 'read: (raw: Executor) => raw.select()')})`,
    guardSource: guard,
  },
  'invalid-guarded-executor-projection': {
    expression: `guarded(${preflight.replace(serviceReadMethod, 'read: transaction.select')})`,
    guardSource: guard,
  },
  'invalid-guarded-unknown-consumer': {
    expression: `guarded(${preflight.replace(serviceResult, 'unknownConsumer(transaction)')})`,
    guardSource: guard,
  },
  'invalid-mutated-error-transform': {
    expression: `Fx.fn('prepare')(function* prepare(payload, context: Preparation) { return ${factory}; }, Fx.mapError(unavailable))`,
    suffix: 'Fx.mapError = replaceFactory;',
  },
  'invalid-mutated-reexport-helper': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/invalid-mutated-reexport-helper.ts";',
  },
  'invalid-raw-error-mapped-factory': {
    expression: `Fx.fn('prepare')(function* prepare(payload, context: Preparation) {
      return ${factory.replace(serviceReadMethod, 'transaction')};
    }, Fx.mapError(unavailable))`,
  },
  'invalid-raw-error-mapped-helper': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/raw-error-mapped.ts";',
  },
  'invalid-raw-guarded-factory': {
    expression: `guarded(${preflight.replace(serviceReadMethod, 'transaction')})`,
    guardSource: guard,
  },
  'invalid-raw-reexport-helper': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/invalid-raw-reexport-helper.ts";',
  },
  'invalid-raw-satisfied-factory': {
    expression: `(${preflight.replace(serviceReadMethod, 'transaction')}) satisfies Preflight<P, S, E>`,
  },
  'invalid-raw-top-level-error-mapped-factory': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/root-raw.ts";',
  },
  'invalid-shadowed-error-transform': {
    expression: `((Fx) => Fx.fn('prepare')(function* prepare(payload, context: Preparation) { return ${factory}; }, Fx.mapError(unavailable)))(fakeEffect)`,
  },
  'invalid-specifier-type-reexport-helper': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/invalid-specifier-type-reexport-helper.ts";',
  },
  'invalid-success-mapped-helper': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/success-mapped.ts";',
  },
  'invalid-success-transform': {
    expression: `Fx.fn('prepare')(function* prepare(payload, context: Preparation) { return ${factory}; }, Fx.map(replaceFactory))`,
  },
  'invalid-success-transform-after-error': {
    expression: `Fx.fn('prepare')(function* prepare(payload, context: Preparation) { return ${factory}; }, Fx.mapError(unavailable), Fx.map(value => value))`,
  },
  'invalid-top-level-unknown-consumer': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/root-unknown.ts";',
  },
  'invalid-type-reexport-helper': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/invalid-type-reexport-helper.ts";',
  },
  'invalid-unproven-helper-executor-input': {
    expression: preflight.replace(
      serviceReturn,
      'const load = (raw: Executor, other: Executor) => other.select(); return { load, current: () => load(transaction, unknownExecutor) };',
    ),
  },
  'valid-closed-helper': {
    expression: preflight.replace(
      serviceReturn,
      'const load = (raw: Executor) => raw.select(); return { current: () => load(transaction) };',
    ),
  },
  'valid-error-mapped-helper': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/error-mapped.ts";',
  },
  'valid-error-mapping': {
    expression: preflight.replace(
      'return { read: () => transaction.select() };\n})',
      'return { read: () => transaction.select() };\n}, Fx.mapError(unavailable), Fx.mapError(sanitize))',
    ),
  },
  'valid-guard-alias': {
    expression: `stableGuard(${preflight}) satisfies Preflight<P, S, E>`,
    guardSource: guard,
    imports: 'const stableGuard = guarded;',
  },
  'valid-imported-guard': { expression: `guarded(${preflight})`, guardSource: guard },
  'valid-multiple-guards': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace(
      '.pipe(Fx.flatMap',
      '.pipe(Fx.flatMap(() => checkStorefront(context.scope.legalEntityId)), Fx.flatMap',
    ),
  },
  'valid-named-reexport-helper': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/valid-named-reexport-helper.ts";',
  },
  'valid-preflight-error-mapping': {
    expression: `Fx.fn('prepare')(function* prepare(payload, context: Preparation) { return ${factory}; }, Fx.mapError(unavailable))`,
  },
  'valid-renamed-export': {
    expression: `guarded(${preflight})`,
    guardSource: guard.replace('withCommandGuard', 'enforceCommand'),
    imports: 'import { enforceCommand as guarded } from "../../shared/valid-renamed-export.ts";',
  },
  'valid-satisfied-factory': {
    expression: preflight.replace(factory, `(${factory}) satisfies Factory<S>`),
  },
  'valid-satisfies': { expression: `(${preflight}) satisfies Preflight<P, S, E>` },
  'valid-top-level-error-mapped-factory': {
    expression: preflight.replace(serviceResult, helperInvocation),
    imports: 'import { make } from "../services/root-error-mapped.ts";',
  },
} satisfies Readonly<Record<string, PreparationCase>>;

const preparationFixtures = (): ReadonlyMap<string, string> => {
  const helper = `${header}
export const make = Fx.fn('make')(
  (transaction: Executor, input: { scope: Scope }) => Fx.succeed({ read: () => transaction.select() }),
  Fx.mapError(unavailable),
);`;
  const rootFactory = `${header}
import { load } from './load.ts';
export const make = Fx.fn('make')(function* make(transaction: Executor, { scope }: { scope: Scope }) {
  const read = () => load(transaction, scope);
  return { read };
}, Fx.mapError(unavailable));`;
  const sources = new Map<string, string>([
    ['verticals/stock/src/services/error-mapped.ts', helper],
    ['verticals/stock/src/services/success-mapped.ts', helper.replace('mapError', 'map')],
    ['verticals/stock/src/services/raw-error-mapped.ts', helper.replace(serviceResult, '{ transaction }')],
    ['verticals/stock/src/services/root-error-mapped.ts', rootFactory],
    ['verticals/stock/src/services/root-raw.ts', rootFactory.replace('return { read };', 'return { transaction };')],
    [
      'verticals/stock/src/services/root-unknown.ts',
      rootFactory.replace('load(transaction, scope)', 'unknownConsumer(transaction, scope)'),
    ],
    [
      'verticals/stock/src/services/load.ts',
      `${header}export const load = (transaction: Executor, scope: Scope) => transaction.select();`,
    ],
    [
      'verticals/stock/src/services/valid-named-reexport-helper.ts',
      'export { make as renamed } from "./error-mapped.ts"; export { renamed as make } from "./reexport-middle.ts";',
    ],
    ['verticals/stock/src/services/reexport-middle.ts', 'export { make as renamed } from "./error-mapped.ts";'],
    ['verticals/stock/src/services/invalid-type-reexport-helper.ts', 'export type { make } from "./error-mapped.ts";'],
    [
      'verticals/stock/src/services/invalid-specifier-type-reexport-helper.ts',
      'export { type make } from "./error-mapped.ts";',
    ],
    ['verticals/stock/src/services/invalid-cyclic-reexport-helper.ts', 'export { make } from "./reexport-cycle.ts";'],
    ['verticals/stock/src/services/reexport-cycle.ts', 'export { make } from "./invalid-cyclic-reexport-helper.ts";'],
    ['verticals/stock/src/services/invalid-raw-reexport-helper.ts', 'export { make } from "./raw-error-mapped.ts";'],
    ['verticals/stock/src/services/invalid-mutated-reexport-helper.ts', 'export { make } from "./mutated-export.ts";'],
    ['verticals/stock/src/services/mutated-export.ts', `${helper}\nmake = counterfeit;`],
  ]);
  for (const [name, fixture] of Object.entries<PreparationCase>(cases)) {
    const defaultImport =
      fixture.guardSource === undefined || fixture.imports?.startsWith('import ') === true
        ? ''
        : `import { withCommandGuard as guarded } from '../../shared/${name}.ts';`;
    sources.set(
      `verticals/stock/src/actions/${name}.action.ts`,
      `${header}${defaultImport}
${fixture.imports ?? ''}
export const prepare = ${fixture.expression};
register(descriptor, handler, ordinary, { prepareServices: prepare });
${fixture.suffix ?? ''}`,
    );
    if (fixture.guardSource !== undefined) {
      sources.set(`verticals/stock/shared/${name}.ts`, fixture.guardSource);
    }
  }
  return sources;
};

it.live('resolves erased syntax, native error transforms and proven guards without trusting wrapper names', () =>
  Effect.sync(() => {
    const sources = preparationFixtures();
    for (const [file, source] of sources) {
      expect(parseSync(file, source, { astType: 'ts', lang: 'ts' }).errors, file).toEqual([]);
    }
    const models = actionPreparationBoundaries(sources, (file, specifier) => {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      return sources.has(resolved) ? resolved : undefined;
    });
    for (const name of Object.keys(cases)) {
      const model = models.get(`verticals/stock/src/actions/${name}.action.ts`);
      expect(model, name).toBeDefined();
      if (name.startsWith('valid-')) {
        expect(model?.preflights.size, name).toBe(1);
        expect(model?.factories.size, name).toBe(1);
      } else if (
        !name.includes('-raw-') &&
        !name.includes('-executor-') &&
        !name.includes('-unknown-consumer') &&
        !name.includes('-helper')
      ) {
        expect(model?.preflights.size, name).toBe(0);
        expect(model?.factories.size, name).toBe(0);
      }
    }
  }),
);

it.live(
  'accepts proven preparation forms while rejecting counterfeit guards, success transforms and capability escapes',
  () =>
    Effect.gen(function* preparationBoundaryControls() {
      const root = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(path.join(os.tmpdir(), 'ontos-preparation-boundary-'))),
        (directory) => Effect.promise(() => rm(directory, { force: true, recursive: true })),
      );
      yield* Effect.forEach(preparationFixtures(), ([relative, source]) =>
        Effect.gen(function* writePreparationFixture() {
          const file = path.join(root, relative);
          yield* Effect.tryPromise(() => mkdir(path.dirname(file), { recursive: true }));
          yield* Effect.tryPromise(() => writeFile(file, source));
        }),
      );
      const violations = yield* checkDatabaseAccessBoundaries(root).pipe(Effect.provide(NodeServices.layer));
      expect(violations.filter(({ file }) => file.includes('/valid-'))).toEqual([]);
      expect(EffectArray.sort([...new Set(violations.map(({ file }) => file))], Order.String)).toEqual(
        EffectArray.sort(
          Object.keys(cases)
            .filter((name) => name.startsWith('invalid-'))
            .map((name) => `verticals/stock/src/actions/${name}.action.ts`),
          Order.String,
        ),
      );
    }),
);
