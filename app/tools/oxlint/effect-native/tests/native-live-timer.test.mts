import { writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';
import { Clock, Effect, Layer } from 'effect';
import { TestClock } from 'effect/testing';

import { appRoot, fixtureConfigPath, runOxlint } from './oxlint.mts';
import { withTemporaryWorkspace } from './temporary-workspace.mts';

const ruleCode = 'effect-native(no-native-timers)';
const effectImport = "import { Effect } from 'effect';";
const liveImports = `${effectImport}\nimport { it } from 'effect-rstest';`;
const waitHelper = "const wait = () => Effect.sleep('1 millis');\nconst bridge = () => wait();";

interface TimerFixture {
  readonly expected: number;
  readonly name: string;
  readonly source: string;
}

const expectTimerFixtures = (fixtures: readonly TimerFixture[]): void => {
  withTemporaryWorkspace((directory) => {
    const files = fixtures.map(({ name, source }) => {
      const file = nodePath.join(directory, `${name}.test.ts`);
      writeFileSync(file, source);
      return file;
    });
    const result = runOxlint(fixtureConfigPath('no-native-timers'), files, appRoot);
    expect(result.numberOfFiles).toBe(fixtures.length);
    expect(result.diagnostics.filter(({ code }) => code !== ruleCode)).toEqual([]);
    for (const [index, fixture] of fixtures.entries()) {
      const diagnostics = result.diagnostics.filter(
        ({ code, filename }) => code === ruleCode && nodePath.resolve(appRoot, filename) === files[index],
      );
      expect(diagnostics, `${fixture.name}: ${JSON.stringify(diagnostics)}`).toHaveLength(fixture.expected);
    }
  });
};

it('proves only SDK layer suites that explicitly exclude the injected test services', () => {
  expectTimerFixtures([
    {
      expected: 0,
      name: 'sdk-explicit-live-layer-suite',
      source: `${liveImports}
declare const layer: unknown;
it.layer(layer, { excludeTestServices: true })((suite) => {
  suite.effect('coordinates a real external race', () => Effect.gen(function* () {
    yield* Effect.sleep('20 millis');
  }));
});`,
    },
    {
      expected: 0,
      name: 'sdk-aliased-live-layer-suite',
      source: `${effectImport}
import { it as sdk } from 'effect-rstest';
declare const layer: unknown;
sdk.layer(layer, { excludeTestServices: true })('external race', (suite) => {
  const register = suite.effect;
  register('wait', () => Effect.sleep('20 millis'));
});`,
    },
    {
      expected: 1,
      name: 'sdk-layer-default-test-services',
      source: `${liveImports}
declare const layer: unknown;
it.layer(layer, { excludeTestServices: false })((suite) => {
  suite.effect('ordinary unit timing', () => Effect.sleep('20 millis'));
});`,
    },
    {
      expected: 1,
      name: 'sdk-layer-without-explicit-clock-selection',
      source: `${liveImports}
declare const layer: unknown;
it.layer(layer)((suite) => {
  suite.effect('ordinary unit timing', () => Effect.sleep('20 millis'));
});`,
    },
    {
      expected: 1,
      name: 'lookalike-layer-runner',
      source: `${effectImport}
declare const layer: unknown;
const it = { layer: (...args: unknown[]) => (register: any) => register({ effect: (...args: unknown[]) => {} }) };
it.layer(layer, { excludeTestServices: true })((suite) => {
  suite.effect('not the SDK', () => Effect.sleep('20 millis'));
});`,
    },
    {
      expected: 1,
      name: 'sdk-layer-shadowed-options',
      source: `${liveImports}
declare const layer: unknown;
const options = { excludeTestServices: true };
function register(options: { excludeTestServices: boolean }) {
  it.layer(layer, options)((suite) => {
    suite.effect('unknown clock', () => Effect.sleep('20 millis'));
  });
}`,
    },
    {
      expected: 1,
      name: 'sdk-layer-mutated-options',
      source: `${liveImports}
declare const layer: unknown;
const options = { excludeTestServices: true };
options.excludeTestServices = false;
it.layer(layer, options)((suite) => {
  suite.effect('unit clock', () => Effect.sleep('20 millis'));
});`,
    },
    {
      expected: 1,
      name: 'sdk-layer-opaque-options-escape',
      source: `${liveImports}
declare const layer: unknown;
declare function configure(options: unknown): void;
const options = { excludeTestServices: true };
configure(options);
it.layer(layer, options)((suite) => {
  suite.effect('unknown clock', () => Effect.sleep('20 millis'));
});`,
    },
    {
      expected: 1,
      name: 'sdk-layer-mutated-suite-method',
      source: `${liveImports}
declare const layer: unknown;
it.layer(layer, { excludeTestServices: true })((suite) => {
  suite.effect = it.effect;
  suite.effect('unit clock', () => Effect.sleep('20 millis'));
});`,
    },
    {
      expected: 1,
      name: 'sdk-layer-native-timer-remains-forbidden',
      source: `${liveImports}
declare const layer: unknown;
it.layer(layer, { excludeTestServices: true })((suite) => {
  suite.effect('native timer', () => {
    setTimeout(() => {}, 20);
    return Effect.void;
  });
});`,
    },
  ]);
});

it('allows Effect sleep and timeoutOrElse inside genuine native live callbacks', () => {
  expectTimerFixtures([
    {
      expected: 0,
      name: 'direct-live-generator',
      source: `${liveImports}
it.live('waits on the live clock', () => Effect.gen(function* liveWait() {
  yield* Effect.sleep('1 millis');
  yield* Effect.void.pipe(Effect.timeoutOrElse({
    duration: '1 second',
    orElse: () => Effect.void,
  }));
}));`,
    },
    {
      expected: 0,
      name: 'aliased-native-runner',
      source: `${effectImport}
import { it as register } from 'effect-rstest';
register.live('waits on the live clock', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 0,
      name: 'namespace-native-runner',
      source: `${effectImport}
import * as runner from 'effect-rstest';
runner.it.live('waits on the live clock', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 0,
      name: 'namespace-native-effect',
      source: `import * as E from 'effect';
import { it } from 'effect-rstest';
it.live('waits through the Effect namespace', () => E.Effect.gen(function* liveWait() {
  yield* E.Effect.sleep('1 millis');
}));`,
    },
    {
      expected: 0,
      name: 'immutable-native-live-alias',
      source: `${liveImports}
const live = it.live;
live('waits on the live clock', () => Effect.sleep('1 millis'));`,
    },
  ]);
});

it('allows immutable helper chains called only by native live callbacks', () => {
  expectTimerFixtures([
    {
      expected: 0,
      name: 'live-only-helper-chain',
      source: `${liveImports}
const wait = () => Effect.void.pipe(Effect.timeoutOrElse({
  duration: '1 second',
  orElse: () => Effect.void,
}));
const bridge = () => wait();
it.live('first live wait', () => bridge());
it.live('second live wait', () => bridge());`,
    },
    {
      expected: 0,
      name: 'live-only-deferred-generator-chain',
      source: `${liveImports}
const wait = () => Effect.gen(function* deferredWait() {
  yield* Effect.sleep('1 millis');
  yield* Effect.void.pipe(Effect.timeoutOrElse({
    duration: '1 second',
    orElse: () => Effect.void,
  }));
});
const bridge = () => wait();
it.live('waits through a deferred generator', () => bridge());`,
    },
    {
      expected: 0,
      name: 'live-only-flatmap-pipe-chain',
      source: `${effectImport}
import { NodeServices } from '@effect/platform-node';
import { Layer } from 'effect';
import { it } from 'effect-rstest';
const wait = () => Effect.gen(function* deferredWait() {
  yield* Effect.sleep('1 millis');
  yield* Effect.void.pipe(Effect.timeoutOrElse({
    duration: '1 second',
    orElse: () => Effect.void,
  }));
});
const bridge = () => Layer.build(NodeServices.layer).pipe(
  Effect.flatMap((nodeServices) => wait().pipe(Effect.provide(nodeServices))),
  Effect.scoped,
);
it.live('waits through a native service bridge', () => bridge());`,
    },
    {
      expected: 0,
      name: 'live-only-native-child-process-chain',
      source: `${liveImports}
import { ChildProcess } from 'effect/process';
const wait = () => Effect.gen(function* deferredWait() {
  const child = yield* ChildProcess.make('node', []);
  yield* child.kill().pipe(Effect.timeoutOrElse({
    duration: '1 second',
    orElse: () => Effect.void,
  }));
});
const bridge = () => wait();
it.live('waits for native process shutdown', () => bridge());`,
    },
  ]);
});

it('rejects helper chains shared with effect or ordinary tests', () => {
  expectTimerFixtures([
    {
      expected: 1,
      name: 'mixed-live-and-effect-helpers',
      source: `${liveImports}
${waitHelper}
it.live('live wait', () => bridge());
it.effect('test-clock wait', () => bridge());`,
    },
    {
      expected: 1,
      name: 'mixed-live-and-ordinary-helpers',
      source: `${liveImports}
${waitHelper}
it.live('live wait', () => bridge());
it('ordinary wait', () => bridge());`,
    },
    {
      expected: 1,
      name: 'nonlive-deferred-generator-helper',
      source: `${liveImports}
const wait = () => Effect.gen(function* deferredWait() {
  yield* Effect.sleep('1 millis');
});
const bridge = () => wait();
it.live('live wait', () => bridge());
it.effect('test-clock wait', () => bridge());`,
    },
  ]);
});

it('rejects foreign, shadowed, type-only, and mutable live runners', () => {
  expectTimerFixtures([
    {
      expected: 1,
      name: 'foreign-live-runner',
      source: `${effectImport}
import { it } from '@rstest/core';
it.live('foreign live wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'shadowed-live-runner',
      source: `${liveImports}
function register(it: typeof import('effect-rstest').it) {
  it.live('shadowed live wait', () => Effect.sleep('1 millis'));
}`,
    },
    {
      expected: 1,
      name: 'type-only-live-runner',
      source: `${effectImport}
import type { it } from 'effect-rstest';
it.live('type-only live wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'mutable-native-live-alias',
      source: `${liveImports}
let live = it.live;
live('mutable live wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'mutable-native-runner-alias',
      source: `${liveImports}
let runner = it;
runner.live('mutable runner wait', () => Effect.sleep('1 millis'));`,
    },
  ]);
});

it('rejects mutated live runner methods and aliases passed to opaque code', () => {
  expectTimerFixtures([
    {
      expected: 1,
      name: 'native-live-alias-method-mutated',
      source: `${liveImports}
const register = it.live;
register.only = it.effect;
register.only('virtual wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'native-live-method-mutated',
      source: `${liveImports}
it.live.only = it.effect;
it.live.only('virtual wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'native-live-alias-escapes-to-opaque-code',
      source: `${liveImports}
declare function mutate(register: typeof it.live): void;
const register = it.live;
mutate(register);
register('live wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'native-live-alias-inherited-getter-mutation',
      source: `${liveImports}
import { effect as virtual } from 'effect-rstest';
const register = it.live;
register.__defineGetter__('only', () => virtual);
register.only('virtual wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'native-live-alias-valueof-mutation',
      source: `${liveImports}
import { effect as virtual } from 'effect-rstest';
const register = it.live;
Object.assign(register.valueOf(), { only: virtual });
register.only('virtual wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'duplicate-native-named-import-mutation',
      source: `${effectImport}
import { it as left, it as right } from 'effect-rstest';
import { effect as virtual } from 'effect-rstest';
left.live.only = virtual;
right.live.only('virtual wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'duplicate-native-namespace-and-named-import-mutation',
      source: `${liveImports}
import * as runner from 'effect-rstest';
import { effect as virtual } from 'effect-rstest';
runner.it.live.only = virtual;
it.live.only('virtual wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'native-literal-dynamic-import-mutation',
      source: `${liveImports}
import { effect as virtual } from 'effect-rstest';
const { it: dynamic } = await import('effect-rstest');
dynamic.live.only = virtual;
it.live.only('virtual wait', () => Effect.sleep('1 millis'));`,
    },
    {
      expected: 1,
      name: 'native-unknown-dynamic-import-mutation',
      source: `${liveImports}
import { effect as virtual } from 'effect-rstest';
const moduleName = 'effect-rstest';
const { it: dynamic } = await import(moduleName);
dynamic.live.only = virtual;
it.live.only('virtual wait', () => Effect.sleep('1 millis'));`,
    },
  ]);
});

it('rejects mutable, exported, passed, and escaped live helpers', () => {
  expectTimerFixtures([
    {
      expected: 1,
      name: 'mutable-live-helper',
      source: `${liveImports}
let wait = () => Effect.sleep('1 millis');
const bridge = () => wait();
it.live('mutable helper wait', () => bridge());`,
    },
    {
      expected: 1,
      name: 'exported-live-helper',
      source: `${liveImports}
export const wait = () => Effect.sleep('1 millis');
const bridge = () => wait();
it.live('exported helper wait', () => bridge());`,
    },
    {
      expected: 1,
      name: 'passed-live-helper',
      source: `${liveImports}
${waitHelper}
function retain(callback: typeof wait) { return callback; }
retain(wait);
it.live('passed helper wait', () => bridge());`,
    },
    {
      expected: 1,
      name: 'stored-live-helper',
      source: `${liveImports}
${waitHelper}
const escaped = { wait };
it.live('stored helper wait', () => bridge());`,
    },
    {
      expected: 1,
      name: 'returned-live-helper',
      source: `${liveImports}
${waitHelper}
const expose = () => wait;
it.live('returned helper wait', () => bridge());`,
    },
  ]);
});

it('rejects deferred helper Effects that live callbacks return or store without executing', () => {
  const deferredWait = `const wait = () => Effect.gen(function* deferredWait() {
  yield* Effect.sleep('1 millis');
});`;
  expectTimerFixtures([
    {
      expected: 1,
      name: 'generator-returns-unexecuted-effect',
      source: `${liveImports}
${deferredWait}
const bridge = () => Effect.gen(function* liveBridge() {
  return wait();
});
it.live('returns an unexecuted Effect', () => bridge());`,
    },
    {
      expected: 1,
      name: 'live-generator-passes-effect-to-storage',
      source: `${liveImports}
${deferredWait}
const stored: unknown[] = [];
it.live('stores an unexecuted Effect', () => Effect.gen(function* liveWait() {
  stored.push(wait());
  yield* Effect.void;
}));`,
    },
    {
      expected: 1,
      name: 'live-generator-assigns-effect-to-property',
      source: `${liveImports}
${deferredWait}
const holder: { effect?: unknown } = {};
it.live('assigns an unexecuted Effect', () => Effect.gen(function* liveWait() {
  holder.effect = wait();
  yield* Effect.void;
}));`,
    },
    {
      expected: 1,
      name: 'live-callback-assigns-effect-to-global-variable',
      source: `${liveImports}
${deferredWait}
let escaped: unknown;
it.live('assigns an unexecuted Effect', () => {
  escaped = wait();
  return Effect.void;
});`,
    },
  ]);
});

it('requires consumed native Effect callbacks before admitting a live timer', () => {
  expectTimerFixtures([
    {
      expected: 1,
      name: 'unused-timer-in-live-generator',
      source: `${liveImports}
it.live('does not execute the timer', () => Effect.gen(function* liveWait() {
  Effect.sleep('1 millis');
  yield* Effect.void;
}));`,
    },
    {
      expected: 1,
      name: 'unknown-callback-in-live',
      source: `${liveImports}
const invoke = (callback: () => unknown) => callback();
it.live('calls an unknown callback API', () => invoke(() => Effect.sleep('1 millis')));`,
    },
    {
      expected: 1,
      name: 'lookalike-pipe-receiver',
      source: `${liveImports}
const receiver = { pipe: (callback: (value: unknown) => unknown) => callback(Effect.void) };
it.live('calls a lookalike pipe', () => receiver.pipe(Effect.flatMap(() => Effect.sleep('1 millis'))));`,
    },
    {
      expected: 1,
      name: 'escaped-named-generator-self',
      source: `${liveImports}
const escaped: unknown[] = [];
it.live('escapes its generator callback', () => Effect.gen(function* liveWait() {
  escaped.push(liveWait);
  yield* Effect.sleep('1 millis');
}));`,
    },
    {
      expected: 1,
      name: 'unconsumed-native-flatmap-callback',
      source: `${liveImports}
const stored: unknown[] = [];
it.live('stores a native flatMap Effect', () => {
  const pending = Effect.void.pipe(Effect.flatMap(() => Effect.sleep('1 millis')));
  stored.push(pending);
  return Effect.void;
});`,
    },
    {
      expected: 1,
      name: 'foreign-child-process-origin',
      source: `${liveImports}
import * as E from 'effect';
it.live('uses an unrelated ChildProcess namespace', () => Effect.gen(function* liveWait() {
  const child = yield* E.ChildProcess.make('node', []);
  yield* child.kill().pipe(Effect.timeoutOrElse({
    duration: '1 second',
    orElse: () => Effect.void,
  }));
}));`,
    },
  ]);
});

it('keeps Effect time outside live callbacks and native timers inside them forbidden', () => {
  expectTimerFixtures([
    {
      expected: 2,
      name: 'unrelated-live-registration',
      source: `${liveImports}
const eagerWait = Effect.sleep('1 millis');
Effect.void.pipe(Effect.timeoutOrElse({
  duration: '1 second',
  orElse: () => Effect.void,
}));
it.live('unrelated live test', () => Effect.void);`,
    },
    {
      expected: 1,
      name: 'helper-called-outside-live',
      source: `${liveImports}
${waitHelper}
bridge();
it.live('live wait', () => bridge());`,
    },
    {
      expected: 1,
      name: 'eager-effect-yielded-by-live-generator',
      source: `${liveImports}
const eagerWait = Effect.sleep('1 millis');
it.live('uses an eagerly constructed timer', () => Effect.gen(function* liveWait() {
  yield* eagerWait;
}));`,
    },
    {
      expected: 1,
      name: 'native-global-live-timer',
      source: `${liveImports}
it.live('native timer', () => {
  setTimeout(() => {}, 1);
  return Effect.void;
});`,
    },
    {
      expected: 2,
      name: 'native-node-live-timer',
      source: `${liveImports}
import { setTimeout as schedule } from 'node:timers';
it.live('native imported timer', () => {
  schedule(() => {}, 1);
  return Effect.void;
});`,
    },
  ]);
});

it('proves deferred immutable programs and native named generator factories independently', () => {
  const cap = "Effect.timeoutOrElse({ duration: '15 seconds', orElse: () => Effect.fail('startup_timeout') })";
  expectTimerFixtures([
    {
      expected: 0,
      name: 'immutable-deferred-program-live-only',
      source: `${liveImports}
const pending = Effect.gen(function* deferredProgram() { yield* Effect.void.pipe(${cap}); });
const alias = pending;
it.live('first', () => alias);
it.live('second', () => pending);`,
    },
    {
      expected: 0,
      name: 'native-named-generator-factory',
      source: `${liveImports}
const acquire = Effect.fn('acquire')(function* acquireReceiver() { yield* Effect.void; });
it.live('first', () => Effect.gen(function* nativeCase() { yield* acquire().pipe(${cap}); }));`,
    },
    {
      expected: 0,
      name: 'actual-deferred-program-native-generator-acquisition',
      source: `${liveImports}
import { Layer, Schema } from 'effect';
class StartupFailed extends Schema.TaggedError<StartupFailed>()('StartupFailed', {}) {}
const acquire = Effect.fn('acquire')(function* acquireReceiver() { yield* Effect.void; });
const pending = Effect.gen(function* nativeCase() {
  yield* acquire().pipe(Effect.timeoutOrElse({ duration: '15 seconds', orElse: () => Effect.fail(new StartupFailed()) }));
});
const services = Layer.empty;
it.live('first', () => pending.pipe(Effect.provide(services)));
it.live('second', () => pending.pipe(Effect.provide(services)));
it.live('third', () => pending.pipe(Effect.provide(services)));`,
    },
  ]);
});

it('rejects opaque or mixed consumers of deferred program values', () => {
  const program = "const pending = Effect.gen(function* deferredProgram() { yield* Effect.sleep('1 millis'); });";
  const consumers = [
    ['direct-non-callable-callback', "it.live('live', pending);"],
    ['aliased-non-callable-callback', "const alias = pending; it.live('live', alias);"],
    ['mixed-effect', "it.live('live', () => pending); it.effect('regular', () => pending);"],
    ['mixed-ordinary', "it.live('live', () => pending); it('regular', () => pending);"],
    ['no-consumer', ''],
    ['unknown-call', "consume(pending); it.live('live', () => pending);"],
    ['object-escape', "const box = { pending }; it.live('live', () => pending);"],
    ['array-escape', "const box = [pending]; it.live('live', () => pending);"],
    ['member-write', "pending.pipe = other; it.live('live', () => pending);"],
    ['alias-escape', "const alias = pending; consume(alias); it.live('live', () => pending);"],
    ['alias-member-write', "const alias = pending; alias.pipe = other; it.live('live', () => pending);"],
    ['unconsumed-live', "it.live('live', () => { pending; return Effect.void; });"],
    ['exported-alias', "export const alias = pending; it.live('live', () => pending);"],
    ['mutable-runner', "it.live = other; it.live('live', () => pending);"],
  ] as const;
  expectTimerFixtures([
    ...consumers.map(([name, body]) => ({
      expected: 1,
      name: `deferred-program-${name}`,
      source: `${liveImports}
${program}
${body}`,
    })),
    {
      expected: 1,
      name: 'exported-deferred-program',
      source: `${liveImports}
export ${program}
it.live('live', () => pending);`,
    },
    {
      expected: 1,
      name: 'mutable-deferred-program',
      source: `${liveImports}
${program.replace('const pending', 'let pending')}
pending = Effect.void; it.live('live', () => pending);`,
    },
    {
      expected: 1,
      name: 'eager-timer-live-only-consumer',
      source: `${liveImports}
const pending = Effect.sleep('1 millis'); it.live('live', () => pending);`,
    },
    {
      expected: 1,
      name: 'deferred-program-cyclic-alias-origin',
      source: `${liveImports}
${program}
const first = second; const second = first; it.live('live', () => condition ? pending : first);`,
    },
  ]);
});

it('does not infer native generator factories from names or unsupported overloads', () => {
  const factories = [
    [
      'fake-builder',
      "const Fake = { fn: () => (callback) => callback }; const acquire = Fake.fn('acquire')(function* () { yield* Effect.void; });",
    ],
    ['mutable-factory', "let acquire = Effect.fn('acquire')(function* () { yield* Effect.void; }); acquire = other;"],
    ['async-generator', "const acquire = Effect.fn('acquire')(async function* () { yield* Effect.void; });"],
    ['ordinary-callback', "const acquire = Effect.fn('acquire')(() => other);"],
    ['extra-transform', "const acquire = Effect.fn('acquire')(function* () { yield* Effect.void; }, other);"],
    [
      'generator-self-escape',
      "const escaped = []; const acquire = Effect.fn('acquire')(function* named() { escaped.push(named); yield* Effect.void; });",
    ],
    [
      'shadowed-effect',
      "function run(Effect) { const acquire = Effect.fn('acquire')(function* () { yield* Effect.void; }); return acquire; } const acquire = run(other);",
    ],
  ] as const;
  expectTimerFixtures(
    factories.map(([name, declaration]) => ({
      expected: 1,
      name: `native-generator-factory-${name}`,
      source: `${liveImports}
${declaration}
it.live('live', () => Effect.gen(function* () {
      yield* acquire().pipe(Effect.timeoutOrElse({ duration: '15 seconds', orElse: () => Effect.void }));
    }));`,
    })),
  );
});

it('models native clock values, context transforms, callable generators and excluded-service layer runners', () => {
  const imports = `${liveImports}\nimport { DateTime, Layer, Context } from 'effect';`;
  const wait = "Effect.gen(function* () { yield* Effect.sleep('1 millis'); })";
  expectTimerFixtures([
    {
      expected: 0,
      name: 'native-datetime-value',
      source: `${imports}\nit.live('x', () => Effect.gen(function* () { yield* DateTime.now; }));`,
    },
    {
      expected: 0,
      name: 'native-datetime-namespace',
      source: `import * as Native from 'effect/DateTime'; ${liveImports}\nit.live('x', () => Effect.gen(function* () { yield* Native.now; }));`,
    },
    {
      expected: 0,
      name: 'native-datetime-direct-value-import',
      source: `import { now } from 'effect/DateTime'; ${liveImports}\nit.live('x', () => Effect.gen(function* () { yield* now; }));`,
    },
    {
      expected: 0,
      name: 'native-provide-context-pipe',
      source: `${imports}\nit.live('x', () => ${wait}.pipe(Effect.provideContext(Context.empty())));`,
    },
    {
      expected: 0,
      name: 'native-provide-context-direct',
      source: `${imports}\nit.live('x', () => Effect.provideContext(${wait}, Context.empty()));`,
    },
    {
      expected: 0,
      name: 'native-scoped-control',
      source: `${imports}\nit.live('x', () => ${wait}.pipe(Effect.scoped));`,
    },
    {
      expected: 0,
      name: 'native-callable-generator-called',
      source: `${imports}\nconst work = Effect.fn('work')(function* workEffect() { yield* DateTime.now; }); it.live('x', () => work());`,
    },
    {
      expected: 0,
      name: 'native-callable-generator-callback',
      source: `${imports}\nconst work = Effect.fn('work')(function* workEffect() { yield* DateTime.now; }); it.live('x', work);`,
    },
    {
      expected: 0,
      name: 'native-layer-anonymous',
      source: `${imports}\nit.layer(Layer.empty, {excludeTestServices:true})((testIt) => { testIt.effect('x', () => ${wait}); });`,
    },
    {
      expected: 0,
      name: 'native-layer-named-actual-generator',
      source: `${imports}\nconst work = Effect.fn('work')(function* workEffect() { yield* DateTime.now; yield* ${wait}.pipe(Effect.provideContext(Context.empty())); }); it.layer(Layer.empty, {excludeTestServices:true})('suite', (testIt) => { testIt.effect('x', work); });`,
    },
  ]);
});

it('keeps native values and excluded-service runner proofs closed', () => {
  const imports = `${liveImports}\nimport { DateTime, Layer, Context } from 'effect';`;
  const work = "const work = Effect.fn('work')(function* workEffect() { yield* DateTime.now; });";
  const registration = "testIt.effect('x', work);";
  const options = [
    ['missing', ''],
    ['false', ', {excludeTestServices:false}'],
    ['unknown', ', options'],
    ['spread', ', {...options, excludeTestServices:true}'],
    ['overridden', ', {excludeTestServices:true, excludeTestServices:false}'],
  ] as const;
  expectTimerFixtures([
    ...options.map(([name, option]) => ({
      expected: 1,
      name: `native-layer-${name}-control`,
      source: `${imports}\n${work}\nit.layer(Layer.empty${option})((testIt) => { ${registration} });`,
    })),
    {
      expected: 1,
      name: 'native-layer-unsupported-scoped',
      source: `${imports}\n${work}\nit.layer(Layer.empty,{excludeTestServices:true})((testIt) => { testIt.scoped('x', work); });`,
    },
    {
      expected: 1,
      name: 'native-layer-aliased-unsupported-scoped',
      source: `${imports}\n${work}\nit.layer(Layer.empty,{excludeTestServices:true})((testIt) => { const register=testIt.scoped; register('x', work); });`,
    },
    {
      expected: 1,
      name: 'native-layer-runner-mutated',
      source: `${imports}\n${work}\nit.layer(Layer.empty,{excludeTestServices:true})((testIt) => { testIt.effect=other; ${registration} });`,
    },
    {
      expected: 1,
      name: 'native-layer-runner-escaped',
      source: `${imports}\n${work}\nit.layer(Layer.empty,{excludeTestServices:true})((testIt) => { consume(testIt); ${registration} });`,
    },
    {
      expected: 1,
      name: 'native-layer-runner-shadowed',
      source: `${imports}\n${work}\nit.layer(Layer.empty,{excludeTestServices:true})((testIt) => { function nested(testIt) { ${registration} } nested(other); });`,
    },
    {
      expected: 1,
      name: 'native-layer-callback-self-escape',
      source: `${imports}\n${work}\nit.layer(Layer.empty,{excludeTestServices:true})(function escaped(testIt) { consume(escaped); ${registration} });`,
    },
    {
      expected: 1,
      name: 'native-layer-fake-origin',
      source: `${imports.replace("import { it } from 'effect-rstest';", '')}\nconst it = other; ${work}\nit.layer(Layer.empty,{excludeTestServices:true})((testIt) => { ${registration} });`,
    },
    {
      expected: 1,
      name: 'native-callable-mixed-virtual',
      source: `${imports}\n${work}\nit.live('x', work); it.effect('virtual', work);`,
    },
    { expected: 1, name: 'native-callable-exported', source: `${imports}\nexport ${work}\nit.live('x', work);` },
    { expected: 1, name: 'native-callable-escaped', source: `${imports}\n${work}\nconsume(work); it.live('x', work);` },
    {
      expected: 1,
      name: 'native-callable-self-escape',
      source: `${imports}\nconst work=Effect.fn('work')(function* named(){ consume(named); yield* DateTime.now; }); it.live('x', work);`,
    },
    {
      expected: 1,
      name: 'native-callable-fake-effect',
      source: `${imports}\nconst Fake={fn:other}; const work=Fake.fn('work')(function*(){yield* DateTime.now;}); it.live('x',work);`,
    },
    {
      expected: 1,
      name: 'native-context-unconsumed',
      source: `${imports}\nit.live('x',()=>{ Effect.gen(function*(){yield* DateTime.now;}).pipe(Effect.provideContext(Context.empty())); return Effect.void; });`,
    },
    {
      expected: 1,
      name: 'native-context-unknown-receiver',
      source: `${imports}\nit.live('x',()=>other.pipe(Effect.flatMap(()=>Effect.gen(function*(){yield* DateTime.now;})),Effect.provideContext(Context.empty())));`,
    },
    {
      expected: 1,
      name: 'native-now-eager-value',
      source: `${imports}\nconst eager=DateTime.now; it.live('x',()=>Effect.gen(function*(){yield* eager;}));`,
    },
    {
      expected: 1,
      name: 'native-now-direct-non-callable',
      source: `import {now} from 'effect/DateTime'; ${liveImports}\nit.live('x',now);`,
    },
    {
      expected: 1,
      name: 'native-now-aliased-non-callable',
      source: `import {now} from 'effect/DateTime'; ${liveImports}\nconst alias=now; it.live('x',alias);`,
    },
    {
      expected: 1,
      name: 'native-now-synchronous-unsafe',
      source: `${imports}\nit.live('x',()=>Effect.sync(()=>DateTime.unsafeNow()));`,
    },
  ]);
});

it('tracks consumed native scoped forks and direct static Effect.all arrays without admitting escapes', () => {
  const imports = `${liveImports}\nimport { DateTime } from 'effect';`;
  const helper =
    "const work = Effect.fn('work')(function* workEffect() { return Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000); });";
  const live = (body: string): string => `${imports}${helper}it.live('x', () => Effect.gen(function* () { ${body} }));`;
  expectTimerFixtures([
    {
      expected: 0,
      name: 'concurrent-direct-yield-math',
      source: `${imports}it.live('x', () => Effect.gen(function* () { return Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000); }));`,
    },
    { expected: 0, name: 'concurrent-helper-direct', source: live('yield* work();') },
    { expected: 0, name: 'concurrent-helper-fork-pipe', source: live('yield* work().pipe(Effect.forkScoped);') },
    { expected: 0, name: 'concurrent-helper-fork-direct', source: live('yield* Effect.forkScoped(work());') },
    {
      expected: 0,
      name: 'concurrent-helper-all-static-array',
      source: live('yield* Effect.all([work(), work()], { concurrency: 2 });'),
    },
    {
      expected: 0,
      name: 'concurrent-helper-fork-and-array',
      source: live('yield* work().pipe(Effect.forkScoped); yield* Effect.all([work(), work()], { concurrency: 2 });'),
    },
    {
      expected: 1,
      name: 'concurrent-virtual-fork',
      source: `${imports}${helper}it.effect('x', () => Effect.gen(function* () { yield* work().pipe(Effect.forkScoped); }));`,
    },
    {
      expected: 1,
      name: 'concurrent-virtual-array',
      source: `${imports}${helper}it.effect('x', () => Effect.all([work(), work()]));`,
    },
    {
      expected: 1,
      name: 'concurrent-mixed-live-virtual',
      source: `${imports}${helper}it.live('x', () => work()); it.effect('y', () => work());`,
    },
    { expected: 1, name: 'concurrent-fake-fork', source: live('yield* work().pipe(Fake.forkScoped);') },
    { expected: 1, name: 'concurrent-fake-all', source: live('yield* Fake.all([work(), work()]);') },
    {
      expected: 1,
      name: 'concurrent-unconsumed-fork',
      source: live('work().pipe(Effect.forkScoped); yield* Effect.void;'),
    },
    {
      expected: 1,
      name: 'concurrent-unconsumed-array',
      source: live('Effect.all([work(), work()]); yield* Effect.void;'),
    },
    {
      expected: 1,
      name: 'concurrent-escaped-array',
      source: live('const items = [work(), work()]; consume(items); yield* Effect.void;'),
    },
    {
      expected: 0,
      name: 'concurrent-native-method-aliases',
      source: live(
        'const fork = Effect.forkScoped; const all = Effect.all; yield* work().pipe(fork); yield* all([work(), work()]);',
      ),
    },
    {
      expected: 1,
      name: 'concurrent-shadowed-fork',
      source: live('const fork = Fake.forkScoped; yield* work().pipe(fork);'),
    },
    { expected: 1, name: 'concurrent-non-first-array', source: live('yield* Effect.all(other, [work()]);') },
    { expected: 1, name: 'concurrent-sparse-array', source: live('yield* Effect.all([work(), ,]);') },
    { expected: 1, name: 'concurrent-spread-array', source: live('yield* Effect.all([work(), ...other]);') },
    { expected: 1, name: 'concurrent-unknown-array-element', source: live('yield* Effect.all([work(), other]);') },
    {
      expected: 1,
      name: 'concurrent-mutable-array',
      source: live('let items = [work()]; items = other; yield* Effect.all(items);'),
    },
    {
      expected: 1,
      name: 'concurrent-immutable-array-alias',
      source: live('const items = [work()]; yield* Effect.all(items);'),
    },
    { expected: 1, name: 'concurrent-unsupported-all-arity', source: live('yield* Effect.all([work()], {}, other);') },
    {
      expected: 1,
      name: 'concurrent-promoted-non-callable-fork',
      source: `${imports}const pending = Effect.forkScoped(Effect.gen(function* () { yield* DateTime.now; })); it.live('x', pending);`,
    },
    {
      expected: 1,
      name: 'concurrent-shared-helper-array-virtual',
      source: `${imports}${helper}it.live('x', () => Effect.all([work()])); it.effect('y', () => Effect.all([work()]));`,
    },
  ]);
});

it('tracks only consumed canonical data-first forEach Effect callbacks on native live owners', () => {
  const imports = `${liveImports}\nimport { DateTime } from 'effect';`;
  const nativeCallback = '(item) => Effect.gen(function* () { return yield* DateTime.now; })';
  const each = `Effect.forEach([1, 2], ${nativeCallback}, { concurrency: 1 })`;
  const live = (body: string): string => `${imports}it.live('x', () => Effect.gen(function* () { ${body} }));`;
  expectTimerFixtures([
    { expected: 0, name: 'foreach-native-returned-generator', source: live(`yield* ${each};`) },
    {
      expected: 0,
      name: 'foreach-native-block-callback',
      source: live(
        'yield* Effect.forEach([1], (item) => { return Effect.gen(function* () { yield* DateTime.now; }); });',
      ),
    },
    {
      expected: 0,
      name: 'foreach-native-named-callback',
      source: live(
        'yield* Effect.forEach([1], function itemEffect(item) { return Effect.gen(function* () { yield* DateTime.now; }); });',
      ),
    },
    {
      expected: 0,
      name: 'foreach-native-method-alias',
      source: live(`const each = Effect.forEach; yield* each([1], ${nativeCallback});`),
    },
    {
      expected: 0,
      name: 'foreach-native-helper-http-shaped-result',
      source: `${imports}const work = () => Effect.gen(function* () { return yield* Effect.forEach([1], (item) => Effect.gen(function* askActualSingleton() { return yield* execute(item, yield* authorization(yield* DateTime.now)); }), { concurrency: 1 }); }); it.live('x', () => work());`,
    },
    {
      expected: 0,
      name: 'foreach-native-time-effect-value',
      source: live('yield* Effect.forEach([1], () => DateTime.now);'),
    },
    { expected: 1, name: 'foreach-virtual-owner', source: `${imports}it.effect('x', () => ${each});` },
    { expected: 1, name: 'foreach-ordinary-owner', source: `${imports}it('x', () => ${each});` },
    {
      expected: 1,
      name: 'foreach-mixed-helper-consumers',
      source: `${imports}const work = () => ${each}; it.live('x', () => work()); it.effect('y', () => work());`,
    },
    { expected: 1, name: 'foreach-fake-method', source: live(`yield* Fake.forEach([1], ${nativeCallback});`) },
    {
      expected: 1,
      name: 'foreach-shadowed-method',
      source: `${imports}const run = (Effect) => Effect.forEach([1], () => DateTime.now); it.live('x', () => run(Fake));`,
    },
    {
      expected: 1,
      name: 'foreach-mutable-method-alias',
      source: live(`let each = Effect.forEach; each = other; yield* each([1], ${nativeCallback});`),
    },
    {
      expected: 1,
      name: 'foreach-async-callback',
      source: live('yield* Effect.forEach([1], async () => DateTime.now);'),
    },
    {
      expected: 1,
      name: 'foreach-generator-callback',
      source: live('yield* Effect.forEach([1], function* () { yield* DateTime.now; });'),
    },
    {
      expected: 1,
      name: 'foreach-non-effect-return',
      source: live('yield* Effect.forEach([1], () => { DateTime.now; return other; });'),
    },
    {
      expected: 1,
      name: 'foreach-escaped-named-callback',
      source: live(
        'yield* Effect.forEach([1], function named() { consume(named); return Effect.gen(function* () { yield* DateTime.now; }); });',
      ),
    },
    {
      expected: 1,
      name: 'foreach-unsupported-arity',
      source: live(`yield* Effect.forEach([1], ${nativeCallback}, {}, other);`),
    },
    { expected: 1, name: 'foreach-spread-call', source: live(`yield* Effect.forEach(...items, ${nativeCallback});`) },
    {
      expected: 1,
      name: 'foreach-wrong-callback-position',
      source: live(`yield* Effect.forEach(${nativeCallback}, items);`),
    },
    { expected: 1, name: 'foreach-unconsumed-result', source: live(`${each}; yield* Effect.void;`) },
    { expected: 1, name: 'foreach-noncallable-test-callback', source: `${imports}it.live('x', ${each});` },
    { expected: 1, name: 'foreach-opaque-result-consumer', source: live(`yield* consume(${each});`) },
    {
      expected: 1,
      name: 'foreach-escaped-program',
      source: live(`const pending = ${each}; consume(pending); yield* Effect.void;`),
    },
    {
      expected: 1,
      name: 'foreach-effect-value-as-callback',
      source: live('yield* Effect.forEach([1], DateTime.now);'),
    },
    {
      expected: 1,
      name: 'foreach-bound-callback-not-proven',
      source: live(`const callback = ${nativeCallback}; yield* Effect.forEach([1], callback);`),
    },
  ]);
});

const explicitMarketDeclaration = 'const market =';
const explicitMarketProvision = '}).pipe(Effect.orDie, Effect.provideService(Clock.Clock, nativeClock));';
const explicitClockCapture = 'const nativeClock = yield* Clock.Clock;';
const explicitClockCallbacks = `import { Clock, Crypto, DateTime, Effect } from 'effect';
import { it } from 'effect-rstest';
import { makeProductionPort } from 'opaque-production-port';
const market = (payload, nativeClock) => Effect.gen(function* marketResponse() {
  return { payload, observedAt: yield* DateTime.now };
}).pipe(Effect.orDie, Effect.provideService(Clock.Clock, nativeClock));
const fixture = (nativeClock) => {
  const issuer = { issue: () => Effect.gen(function* issueActualAssertion() {
    return yield* DateTime.now;
  }).pipe(Effect.orDie, Effect.provideService(Clock.Clock, nativeClock), Effect.provideService(Crypto.Crypto, crypto)) };
  return makeProductionPort({ market: { execute: payload => market(payload, nativeClock) }, issuer });
};
it.live('actual live callbacks', () => Effect.gen(function* runLive() {
  const nativeClock = yield* Clock.Clock;
  yield* fixture(nativeClock);
}));`;

it('proves exact immutable live Clock capture supplied to whole deferred callbacks through local parameters', () => {
  expectTimerFixtures([
    { expected: 0, name: 'explicit-live-clock-production-port-callbacks', source: explicitClockCallbacks },
    {
      expected: 1,
      name: 'explicit-clock-reject-inner-alias-provider',
      source: explicitClockCallbacks
        .replace(explicitMarketDeclaration, 'const aliasClock = Clock.Clock; const market =')
        .replace(
          explicitMarketProvision,
          '}).pipe(Effect.orDie, Effect.provideService(aliasClock, fakeClock), Effect.provideService(Clock.Clock, nativeClock));',
        ),
    },
    {
      expected: 0,
      name: 'explicit-clock-allow-outer-alias-provider',
      source: explicitClockCallbacks
        .replace(explicitMarketDeclaration, 'const aliasClock = Clock.Clock; const market =')
        .replace(
          explicitMarketProvision,
          '}).pipe(Effect.orDie, Effect.provideService(Clock.Clock, nativeClock), Effect.provideService(aliasClock, fakeClock));',
        ),
    },
    {
      expected: 0,
      name: 'explicit-live-clock-aliased-namespace',
      source: explicitClockCallbacks
        .replace('Clock, Crypto', 'Clock as NativeClock, Crypto')
        .replaceAll('Clock.Clock', 'NativeClock.Clock'),
    },
    {
      expected: 2,
      name: 'explicit-clock-ordinary-owner',
      source: explicitClockCallbacks.replace('it.live(', 'it.effect('),
    },
    {
      expected: 2,
      name: 'explicit-clock-mixed-origins',
      source: `${explicitClockCallbacks}\nit.effect('virtual callbacks', () => Effect.gen(function* () { const ordinaryClock = yield* Clock.Clock; yield* fixture(ordinaryClock); }));`,
    },
    {
      expected: 2,
      name: 'explicit-clock-unknown-origin',
      source: explicitClockCallbacks.replace(explicitClockCapture, 'const nativeClock = unknownClock;'),
    },
    {
      expected: 2,
      name: 'explicit-clock-reassigned-origin',
      source: explicitClockCallbacks.replace(
        explicitClockCapture,
        'let nativeClock = yield* Clock.Clock; nativeClock = unknownClock;',
      ),
    },
    {
      expected: 2,
      name: 'explicit-clock-wrong-service-key',
      source: explicitClockCallbacks.replaceAll(
        'provideService(Clock.Clock, nativeClock)',
        'provideService(Crypto.Crypto, nativeClock)',
      ),
    },
    {
      expected: 2,
      name: 'explicit-clock-partially-provided-callbacks',
      source: explicitClockCallbacks.replace(explicitMarketProvision, '}).pipe(Effect.orDie);'),
    },
    {
      expected: 2,
      name: 'explicit-clock-escaped-origin',
      source: explicitClockCallbacks.replace(
        'yield* fixture(nativeClock);',
        'store(nativeClock); yield* fixture(nativeClock);',
      ),
    },
    {
      expected: 2,
      name: 'explicit-clock-shared-ordinary-origin',
      source: explicitClockCallbacks.replace(
        explicitClockCapture,
        'sharedClock = yield* Clock.Clock; const nativeClock = sharedClock;',
      ),
    },
    {
      expected: 2,
      name: 'explicit-clock-shadowed-clock-namespace',
      source: explicitClockCallbacks
        .replace('Clock, Crypto', 'Crypto')
        .replace(explicitMarketDeclaration, 'const Clock = fakeClock; const market ='),
    },
    {
      expected: 1,
      name: 'explicit-clock-generator-self-escape',
      source: explicitClockCallbacks.replace(
        'return { payload, observedAt:',
        'store(marketResponse); return { payload, observedAt:',
      ),
    },
    {
      expected: 2,
      name: 'explicit-clock-mutated-native-service-key',
      source: `${explicitClockCallbacks}\nClock.Clock = fakeClock;`,
    },
  ]);
});

it.effect('the innermost provided Clock controls real Effect clock execution despite an outer alias provider', () =>
  Effect.gen(function* verifyClockProviderPrecedence() {
    const actualClock = yield* TestClock.make();
    const aliasClock = Clock.Clock;
    const innerClock = { ...actualClock, currentTimeMillis: Effect.succeed(1000), currentTimeMillisUnsafe: () => 1000 };
    const outerClock = { ...actualClock, currentTimeMillis: Effect.succeed(2000), currentTimeMillisUnsafe: () => 2000 };
    expect(
      yield* Clock.currentTimeMillis.pipe(
        Effect.provideService(Clock.Clock, innerClock),
        Effect.provideService(aliasClock, outerClock),
      ),
    ).toBe(1000);
    expect(
      yield* Clock.currentTimeMillis.pipe(
        Effect.provideService(aliasClock, outerClock),
        Effect.provideService(Clock.Clock, innerClock),
      ),
    ).toBe(2000);
  }),
);

it('proves explicitly supplied live Clock through canonical Effect.fn parameters only', () => {
  const source = `import { Clock, DateTime, Effect } from 'effect';
import { it } from 'effect-rstest';
const receiver = Effect.fn('receiver')(function* receiver(nativeClock: Clock.Clock) {
  return () => Effect.gen(function* observe() {
    return yield* DateTime.now;
  }).pipe(Effect.provideService(Clock.Clock, nativeClock));
});
it.live('actual IO', () => Effect.gen(function* live() {
  const nativeClock = yield* Clock.Clock;
  yield* receiver(nativeClock);
}));`;
  expectTimerFixtures([
    { expected: 0, name: 'native-fn-clock-parameter', source },
    {
      expected: 1,
      name: 'native-fn-unknown-clock',
      source: source.replace('receiver(nativeClock);', 'receiver(unknownClock);'),
    },
    {
      expected: 1,
      name: 'native-fn-clock-escape',
      source: source.replace('return () => Effect.gen', 'consume(nativeClock); return () => Effect.gen'),
    },
    { expected: 1, name: 'native-fn-mixed-clock-origin', source: `${source}\nreceiver(unknownClock);` },
    {
      expected: 1,
      name: 'native-fn-clock-reassignment',
      source: source.replace('return () => Effect.gen', 'nativeClock = unknownClock; return () => Effect.gen'),
    },
    {
      expected: 1,
      name: 'native-fn-shadowed-factory',
      source: source.replace(
        "const receiver = Effect.fn('receiver')",
        "const fake = source; const receiver = fake.fn('receiver')",
      ),
    },
    { expected: 1, name: 'native-fn-helper-reassignment', source: `${source}\nreceiver = replacement;` },
  ]);
});

const layerTimeoutSource = (options: string) => `import { Effect, Layer } from 'effect';
import { it } from 'effect-rstest';
it.layer(Layer.empty, ${options})((suite) => {
  suite.effect('real IO', () => Effect.sleep('1 millis'));
});`;

it('keeps an orthogonal literal layer timeout compatible with explicit real test services', () => {
  expectTimerFixtures([
    {
      expected: 0,
      name: 'layer-real-literal-timeout',
      source: layerTimeoutSource('{ excludeTestServices: true, timeout: 600_000 }'),
    },
    {
      expected: 0,
      name: 'layer-real-timeout-order',
      source: layerTimeoutSource('{ timeout: 600_000, excludeTestServices: true }'),
    },
    {
      expected: 0,
      name: 'layer-real-duration-string-timeout',
      source: layerTimeoutSource("{ excludeTestServices: true, timeout: '60 seconds' }"),
    },
    {
      expected: 1,
      name: 'layer-empty-duration-string-timeout',
      source: layerTimeoutSource("{ excludeTestServices: true, timeout: '' }"),
    },
    {
      expected: 1,
      name: 'layer-timeout-virtual-services',
      source: layerTimeoutSource('{ excludeTestServices: false, timeout: 600_000 }'),
    },
    {
      expected: 1,
      name: 'layer-timeout-unknown-option',
      source: layerTimeoutSource('{ excludeTestServices: true, timeout: 600_000, other: true }'),
    },
    {
      expected: 1,
      name: 'layer-timeout-spread',
      source: layerTimeoutSource('{ excludeTestServices: true, ...options, timeout: 600_000 }'),
    },
    {
      expected: 1,
      name: 'layer-timeout-duplicate',
      source: layerTimeoutSource('{ excludeTestServices: true, timeout: 600_000, timeout: 1 }'),
    },
    {
      expected: 1,
      name: 'layer-timeout-computed',
      source: layerTimeoutSource("{ excludeTestServices: true, ['timeout']: 600_000 }"),
    },
    {
      expected: 1,
      name: 'layer-timeout-dynamic',
      source: layerTimeoutSource('{ excludeTestServices: true, timeout: configured }'),
    },
    {
      expected: 1,
      name: 'layer-timeout-getter',
      source: layerTimeoutSource('{ excludeTestServices: true, get timeout() { return 600_000; } }'),
    },
  ]);
});

const sharedMemoMapDeclaration = 'const sharedMemoMap';
const excludedLayerServices = 'excludeTestServices: true';

const sharedMemoMapSource = `import { Effect, Layer } from 'effect';
import { it } from 'effect-rstest';
const sharedMemoMap = Layer.makeMemoMapUnsafe();
const wait = () => Effect.sleep('1 millis');
it.layer(Layer.empty, { excludeTestServices: true, memoMap: sharedMemoMap, timeout: 30_000 })((outer) => {
  outer.effect('outer native', wait);
  it.layer(Layer.empty, { memoMap: sharedMemoMap, excludeTestServices: true })((inner) => {
    inner.effect('inner native', wait);
  });
});`;

it('confines a shared mutable layer cache to immutable native-only memo-map bindings', () => {
  expectTimerFixtures([
    { expected: 0, name: 'native-shared-memo-map', source: sharedMemoMapSource },
    {
      expected: 0,
      name: 'native-shared-memo-map-import-alias',
      source: sharedMemoMapSource.replace('Effect, Layer', 'Effect, Layer as L').replaceAll('Layer.', 'L.'),
    },
    {
      expected: 1,
      name: 'memo-map-mixed-default-consumer',
      source: `${sharedMemoMapSource}\nit.layer(Layer.empty, { memoMap: sharedMemoMap })((suite) => { suite.effect('virtual', () => Effect.void); });`,
    },
    {
      expected: 1,
      name: 'memo-map-mixed-false-consumer',
      source: `${sharedMemoMapSource}\nit.layer(Layer.empty, { excludeTestServices: false, memoMap: sharedMemoMap })((suite) => { suite.effect('virtual', () => Effect.void); });`,
    },
    {
      expected: 1,
      name: 'memo-map-shared-helper-virtual-consumer',
      source: `${sharedMemoMapSource}\nit.effect('virtual helper', wait);`,
    },
    { expected: 1, name: 'memo-map-opaque-escape', source: `${sharedMemoMapSource}\nconsume(sharedMemoMap);` },
    {
      expected: 1,
      name: 'memo-map-cache-mutation',
      source: `${sharedMemoMapSource}\nsharedMemoMap.get = replacement;`,
    },
    {
      expected: 1,
      name: 'memo-map-binding-reassignment',
      source: `${sharedMemoMapSource}\nsharedMemoMap = replacement;`,
    },
    {
      expected: 1,
      name: 'memo-map-mutable-binding',
      source: sharedMemoMapSource.replace(sharedMemoMapDeclaration, 'let sharedMemoMap'),
    },
    {
      expected: 1,
      name: 'memo-map-unknown-construction',
      source: sharedMemoMapSource.replace('Layer.makeMemoMapUnsafe()', 'makeUnknownMap()'),
    },
    {
      expected: 1,
      name: 'memo-map-fake-layer',
      source: sharedMemoMapSource
        .replace('Effect, Layer', 'Effect')
        .replace(sharedMemoMapDeclaration, 'const Layer = fake; const sharedMemoMap'),
    },
    {
      expected: 1,
      name: 'memo-map-mutated-constructor',
      source: `${sharedMemoMapSource}\nLayer.makeMemoMapUnsafe = replacement;`,
    },
    {
      expected: 1,
      name: 'memo-map-exported-binding',
      source: sharedMemoMapSource.replace(sharedMemoMapDeclaration, 'export const sharedMemoMap'),
    },
    {
      expected: 1,
      name: 'memo-map-native-js-timer',
      source: `${sharedMemoMapSource}\nit.live('native timer remains forbidden', () => Effect.sync(() => setTimeout(() => {}, 1)));`,
    },
    ...[
      ['duplicate', 'memoMap: sharedMemoMap, memoMap: sharedMemoMap'],
      ['computed', "['memoMap']: sharedMemoMap"],
      ['getter', 'get memoMap() { return sharedMemoMap; }'],
      ['spread', '...options, memoMap: sharedMemoMap'],
      ['unknown-option', 'memoMap: sharedMemoMap, other: true'],
    ].map(([name, option]) => ({
      expected: 1,
      name: `memo-map-${name}-consumer`,
      source: sharedMemoMapSource.replaceAll('memoMap: sharedMemoMap', option ?? ''),
    })),
  ]);
});

const artifactServiceConstructor = "Context.Service('fixture/artifacts')";
const nativeLocalProvision = 'Effect.provide(NodeServices.layer, { local: true })';

const nativeLayerFactorySource = `import { Clock, Context, DateTime, Effect, Layer } from 'effect';
import { NodeServices } from '@effect/platform-node';
import { it } from 'effect-rstest';
const Artifacts = Context.Service('fixture/artifacts');
const Infrastructure = Context.Service('fixture/infrastructure');
const artifacts = Layer.effect(Artifacts, Effect.succeed({ prepared: true })).pipe(Layer.provideMerge(NodeServices.layer));
const authority = Effect.fn('authority')(function* authority(clock) {
  const issue = () => Effect.gen(function* issue() {
    return yield* DateTime.now;
  }).pipe(Effect.provideService(Clock.Clock, clock));
  return { issue };
});
const prepare = Effect.fn('prepare')(function* prepare(mode, clock, control = 'default') {
  return yield* authority(clock);
});
const makeLayer = (mode, control = 'default') => Layer.effect(Infrastructure, Effect.gen(function* infrastructure() {
  const clock = yield* Clock.Clock;
  return yield* prepare(mode, clock, control);
}));
const cache = Layer.makeMemoMapUnsafe();
it.layer(artifacts, { excludeTestServices: true, memoMap: cache })(() => {
  it.layer(makeLayer('first').pipe(Layer.provideMerge(artifacts)), { excludeTestServices: true, memoMap: cache })((suite) => {
    suite.effect('first native case', () => Effect.void);
  });
  it.layer(makeLayer('second').pipe(Layer.provideMerge(artifacts)), { excludeTestServices: true, memoMap: cache })((suite) => {
    suite.effect('second native case', () => Effect.void);
  });
});`;

const nativeFactoryWithObserver = nativeLayerFactorySource
  .replace('return yield* DateTime.now;', 'return yield* observe();')
  .replace(
    'const authority =',
    "const observe = Effect.fn('observe')(function* observe() { return yield* DateTime.now; }); const authority =",
  );

it('proves captured Clock origins only through fully confined clock-preserving local layer factories', () => {
  expect(Clock.Clock.key).toBe('effect/Clock');
  expectTimerFixtures([
    { expected: 0, name: 'native-layer-factory-forwarded-clock', source: nativeLayerFactorySource },
    {
      expected: 0,
      name: 'native-layer-factory-local-io-provision',
      source: `${nativeLayerFactorySource}\nconst localIo = Effect.void.pipe(${nativeLocalProvision});`,
    },
    {
      expected: 1,
      name: 'layer-factory-opaque-io-options',
      source: `${nativeLayerFactorySource}\nconst localIo = Effect.void.pipe(Effect.provide(NodeServices.layer, unknownOptions));`,
    },
    {
      expected: 0,
      name: 'native-layer-factory-shared-timed-helper',
      source: nativeFactoryWithObserver,
    },
    {
      expected: 1,
      name: 'layer-factory-shared-timed-helper-virtual-consumer',
      source: `${nativeFactoryWithObserver}\nit.effect('virtual observation', observe);`,
    },
    {
      expected: 0,
      name: 'native-layer-factory-namespace-alias',
      source: nativeLayerFactorySource
        .replace('Clock, Context,', 'Clock, Context as C,')
        .replaceAll('Context.Service', 'C.Service'),
    },
    ...[
      [
        'default-consumer',
        "it.layer(makeLayer('virtual'))((suite) => { suite.effect('virtual', () => Effect.void); });",
      ],
      [
        'false-consumer',
        "it.layer(makeLayer('virtual'), { excludeTestServices: false })((suite) => { suite.effect('virtual', () => Effect.void); });",
      ],
      ['ordinary-consumer', "it.effect('virtual', () => makeLayer('virtual'));"],
      ['escaped-factory', 'consume(makeLayer);'],
      ['exported-factory-alias', 'export { makeLayer };'],
      ['reassigned-factory', 'makeLayer = replacement;'],
      ['factory-property-mutation', 'makeLayer.call = replacement;'],
      ['optional-factory-call', "makeLayer?.('optional');"],
      ['spread-factory-call', 'makeLayer(...args);'],
      ['unknown-forwarded-clock', 'authority(unknownClock);'],
      ['clock-opaque-escape', 'consume(Clock.Clock);'],
      ['service-tag-mutation', 'Artifacts.key = other;'],
      ['service-tag-escape', 'consume(Artifacts);'],
    ].map(([name, tail]) => ({
      expected: 1,
      name: `layer-factory-${name}`,
      source: `${nativeLayerFactorySource}\n${tail}`,
    })),
    ...[
      ['async-factory', "const makeLayer = async (mode, control = 'default') =>"],
      ['exported-factory', "export const makeLayer = (mode, control = 'default') =>"],
      ['mutable-factory', "let makeLayer = (mode, control = 'default') =>"],
      ['opaque-default-parameter', 'const makeLayer = (mode, control = unknownDefault()) =>'],
    ].map(([name, replacement]) => ({
      expected: 1,
      name: `layer-factory-${name}`,
      source: nativeLayerFactorySource.replace("const makeLayer = (mode, control = 'default') =>", replacement ?? ''),
    })),
    ...[
      ['unknown-provider', 'Layer.provideMerge(unknownProvider)'],
      ['clock-override', 'Layer.provideMerge(Layer.succeed(Clock.Clock, virtualClock))'],
      ['aliased-clock-override', 'Layer.provideMerge(Layer.succeed(clockAlias, virtualClock))'],
      ['test-clock-provider', 'Layer.provideMerge(VirtualClock.layer())'],
      ['opaque-composition', 'opaqueCompose(artifacts)'],
      ['computed-composition', "Layer['provideMerge'](artifacts)"],
      ['cyclic-provider', 'Layer.provideMerge(artifacts)'],
    ].map(([name, replacement]) => ({
      expected: 1,
      name: `layer-factory-${name}`,
      source: nativeLayerFactorySource
        .replace(
          'import { it }',
          `import * as VirtualClock from 'effect/testing/TestClock';\n${name === 'aliased-clock-override' ? 'const clockAlias = Clock.Clock;' : ''}\nimport { it }`,
        )
        .replace('Layer.provideMerge(NodeServices.layer)', replacement ?? ''),
    })),
    {
      expected: 1,
      name: 'layer-factory-clock-tag-collision',
      source: nativeLayerFactorySource.replace(artifactServiceConstructor, "Context.Service('effect/Clock')"),
    },
    {
      expected: 1,
      name: 'layer-factory-unknown-service-key',
      source: nativeLayerFactorySource.replace(artifactServiceConstructor, 'Context.Service(unknownKey)'),
    },
    {
      expected: 1,
      name: 'layer-factory-clock-tag-alias',
      source: nativeLayerFactorySource.replace(artifactServiceConstructor, 'Clock.Clock'),
    },
    {
      expected: 1,
      name: 'layer-factory-fake-tag-constructor',
      source: nativeLayerFactorySource.replace(artifactServiceConstructor, "unknown.Service('fixture/artifacts')"),
    },
    {
      expected: 1,
      name: 'layer-factory-native-js-timer',
      source: `${nativeLayerFactorySource}\nit.live('native JS remains rejected', () => Effect.sync(() => setTimeout(() => {}, 1)));`,
    },
  ]);
});

const clockMillisMember = 'clock.currentTimeMillis';

it('preserves captured Clock provenance through direct readonly time observations', () => {
  const source = `import { Clock, DateTime, Effect } from 'effect';
import { it } from 'effect-rstest';
const native = Effect.fn('native')(function* native(clock: Clock.Clock) {
  const observed = yield* clock.currentTimeMillis;
  return yield* Effect.gen(function* lifetime() {
    return yield* DateTime.now;
  }).pipe(Effect.provideService(Clock.Clock, clock));
});

it.live('actual IO', () => Effect.gen(function* live() {
  const clock = yield* Clock.Clock;
  yield* native(clock);
}));`;
  expectTimerFixtures([
    { expected: 0, name: 'clock-direct-readonly-millis', source },
    {
      expected: 0,
      name: 'clock-direct-readonly-nanos',
      source: source.replace(clockMillisMember, 'clock.currentTimeNanos'),
    },
    {
      expected: 1,
      name: 'clock-observer-member-mutation',
      source: source.replace('const observed = yield* clock.currentTimeMillis;', 'clock.currentTimeMillis = fake;'),
    },
    {
      expected: 1,
      name: 'clock-observer-method-escape',
      source: source.replace('const observed = yield* clock.currentTimeMillis;', 'consume(clock.currentTimeMillis);'),
    },
    {
      expected: 1,
      name: 'clock-observer-computed',
      source: source.replace(clockMillisMember, "clock['currentTimeMillis']"),
    },
    {
      expected: 1,
      name: 'clock-observer-unknown-member',
      source: source.replace(clockMillisMember, 'clock.unknown'),
    },
    {
      expected: 1,
      name: 'clock-observer-unknown-origin',
      source: source.replace('native(clock);', 'native(unknownClock);'),
    },
  ]);
});

const nativeLayerNodeServicesMerge = 'Layer.provideMerge(NodeServices.layer)';
const nativeLayerServicesProvision = 'Layer.provide(services)';

it('proves native Layer.effect setup only through exclusively excluded local layer consumers', () => {
  const source = `import { Clock, Context, Effect, Layer } from 'effect';
import { NodeChildProcessSpawner, NodeServices, NodeCrypto } from '@effect/platform-node';
import { FetchHttpClient } from 'effect/http';
import { it } from 'effect-rstest';
const services = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(FetchHttpClient.layer));
const prepare = Effect.fn('prepare')(function* prepare() {
  yield* Effect.void.pipe(Effect.timeoutOrElse({ duration: '1 second', orElse: () => Effect.void }));
});
const artifacts = Layer.effect(Service, Effect.gen(function* prepareArtifacts() {
  return yield* prepare();
})).pipe(Layer.provide(services));
const retained = artifacts;
it.layer(retained, { excludeTestServices: true })((suite) => {
  suite.effect('actual native IO', () => Effect.void);
});`;
  const shared = source
    .replace(
      'const retained = artifacts;',
      'const retained = artifacts; const sharedMemoMap = Layer.makeMemoMapUnsafe();',
    )
    .replace(excludedLayerServices, 'excludeTestServices: true, memoMap: sharedMemoMap');
  const sharedSetup = `${shared}\nit.layer(artifacts, { excludeTestServices: true, memoMap: sharedMemoMap })((suite) => { suite.effect('second native observer', () => Effect.void); });`;
  expectTimerFixtures([
    { expected: 0, name: 'native-layer-exclusive-setup', source },
    { expected: 0, name: 'native-shared-memo-map-layer-setup', source: sharedSetup },
    {
      expected: 1,
      name: 'shared-memo-map-test-clock-dependency',
      source: sharedSetup.replace(nativeLayerServicesProvision, 'Layer.provide(TestClock.layer())'),
    },
    {
      expected: 1,
      name: 'shared-memo-map-clock-override',
      source: sharedSetup.replace(
        nativeLayerServicesProvision,
        'Layer.provide(Layer.succeed(Clock.Clock, unknownClock))',
      ),
    },
    {
      expected: 1,
      name: 'shared-memo-map-mixed-clock-merge',
      source: sharedSetup.replace(
        nativeLayerServicesProvision,
        'Layer.provide(Layer.merge(services, Layer.succeed(Clock.Clock, unknownClock)))',
      ),
    },
    {
      expected: 0,
      name: 'native-layer-immutable-native-alias',
      source: source
        .replace('const services =', 'const nativeIo = NodeServices.layer; const services =')
        .replace(nativeLayerNodeServicesMerge, 'Layer.provideMerge(nativeIo)'),
    },

    {
      expected: 1,
      name: 'native-layer-ordinary-setup',
      source: source.replace(excludedLayerServices, 'excludeTestServices: false'),
    },
    {
      expected: 1,
      name: 'native-layer-mixed-setup',
      source: `${source}\nit.layer(artifacts)((suite) => { suite.effect('virtual', () => Effect.void); });`,
    },
    { expected: 1, name: 'native-layer-escaped-setup', source: `${source}\nconsume(artifacts);` },
    {
      expected: 1,
      name: 'native-layer-exported-setup',
      source: source.replace('const artifacts =', 'export const artifacts ='),
    },
    { expected: 1, name: 'native-layer-reassigned-setup', source: `${source}\nartifacts = unknown;` },
    {
      expected: 1,
      name: 'native-layer-fake-constructor',
      source: source.replace('Layer.effect(Service,', 'fake.effect(Service,'),
    },

    {
      expected: 1,
      name: 'native-layer-cyclic-native-alias',
      source: source.replace(nativeLayerNodeServicesMerge, 'Layer.provideMerge(services)'),
    },
    {
      expected: 1,
      name: 'native-layer-mutated-native-alias',
      source: source.replace('const services =', 'let services ='),
    },
    {
      expected: 1,
      name: 'native-layer-computed-transform',
      source: source.replace(nativeLayerNodeServicesMerge, "Layer['provideMerge'](NodeServices.layer)"),
    },
    {
      expected: 1,
      name: 'native-layer-unknown-transform',
      source: source.replace(nativeLayerServicesProvision, 'unknownTransform'),
    },
    {
      expected: 1,
      name: 'native-layer-unknown-dependency',
      source: source.replace(nativeLayerServicesProvision, 'Layer.provide(unknownServices)'),
    },
    {
      expected: 1,
      name: 'native-layer-test-clock-dependency',
      source: source.replace(nativeLayerServicesProvision, 'Layer.provide(TestClock.layer())'),
    },
    {
      expected: 1,
      name: 'native-layer-clock-key-override',
      source: source.replace(nativeLayerServicesProvision, 'Layer.provide(Layer.succeed(Clock.Clock, fakeClock))'),
    },
    {
      expected: 1,
      name: 'native-layer-aliased-clock-override',
      source: source
        .replace('const artifacts =', 'const override = TestClock.layer(); const artifacts =')
        .replace(nativeLayerServicesProvision, 'Layer.provide(override)'),
    },
    {
      expected: 1,
      name: 'native-layer-mixed-clock-merge',
      source: source.replace(
        nativeLayerServicesProvision,
        'Layer.provide(Layer.mergeAll(services, TestClock.layer()))',
      ),
    },
    {
      expected: 1,
      name: 'native-layer-mutated-native-namespace',
      source: `${source}\nNodeServices.layer = TestClock.layer();`,
    },
    { expected: 1, name: 'native-layer-escaped-native-leaf', source: `${source}\nconsume(NodeServices.layer);` },
    { expected: 1, name: 'native-layer-escaped-native-dependency', source: `${source}\nconsume(services);` },
    {
      expected: 1,
      name: 'native-layer-escaped-composed-dependency',
      source: `${source}\nconsume(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer));`,
    },
    {
      expected: 1,
      name: 'native-layer-escaped-provide-transform',
      source: `${source}\nconsume(Layer.provide(NodeServices.layer));`,
    },
  ]);
});

const streamHeadMember = 'Stream.runHead';

it('recognizes exact imported data-first Stream terminals as Effect boundaries', () => {
  const source = `import { Effect, Stream } from 'effect';
import { it } from 'effect-rstest';
const first = Effect.fn('first')(function* first(stream) {
  return yield* Stream.runHead(stream).pipe(Effect.timeoutOrElse({ duration: '1 second', orElse: () => Effect.void }));
});
it.live('native terminal', () => first(stream));`;
  expectTimerFixtures([
    { expected: 0, name: 'native-stream-head', source },
    { expected: 0, name: 'native-stream-collect', source: source.replace(streamHeadMember, 'Stream.runCollect') },
    { expected: 0, name: 'native-stream-drain', source: source.replace(streamHeadMember, 'Stream.runDrain') },
    { expected: 1, name: 'native-stream-ordinary', source: source.replace('it.live', 'it.effect') },
    { expected: 1, name: 'native-stream-mixed', source: `${source}\nit.effect('virtual', () => first(stream));` },
    { expected: 1, name: 'native-stream-fake', source: source.replace(streamHeadMember, 'fake.runHead') },
    {
      expected: 1,
      name: 'native-stream-shadowed',
      source: source.replace('Effect, Stream', 'Effect').replace('const first =', 'const Stream = fake; const first ='),
    },
    { expected: 1, name: 'native-stream-unknown-terminal', source: source.replace(streamHeadMember, 'Stream.unknown') },
    { expected: 1, name: 'native-stream-escaped-helper', source: `${source}\nconsume(first);` },
    { expected: 1, name: 'native-stream-mutated-terminal', source: `${source}\nStream.runHead = fake;` },
    { expected: 1, name: 'native-stream-escaped-namespace', source: `${source}\nconsume(Stream);` },
  ]);
});

const nativeClockSleepCall = 'clock.sleep(duration)';

const nestedNativeLayerSource = `import { Clock, Context, Effect, Layer, Stream } from 'effect';
import { NodeChildProcessSpawner, NodeServices, NodeCrypto } from '@effect/platform-node';
import { FetchHttpClient } from 'effect/http';
import { it } from 'effect-rstest';
const defaultNativeClock = Clock.Clock.defaultValue();
const nativeServices = NodeChildProcessSpawner.layer.pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(NodeCrypto.layer), Layer.provideMerge(FetchHttpClient.layer));
const Artifacts = Context.Service('native-test/artifacts');
const Infrastructure = Context.Service('native-test/infrastructure');
const commandOutput = Effect.fn('commandOutput')(function* commandOutput() {
  yield* Effect.void.pipe(Effect.timeoutOrElse({ duration: '1 second', orElse: () => Effect.void }));
});
const artifacts = Layer.effect(Artifacts, Effect.gen(function* prepareArtifacts() {
  return yield* commandOutput();
}).pipe(Effect.provideService(Clock.Clock, defaultNativeClock))).pipe(Layer.provide(nativeServices));
const acquire = Effect.fn('acquire')(function* acquire() {
  const clock = yield* Clock.Clock;
  const endpoint = Effect.gen(function* deferredEndpoint() {
    yield* Effect.tryPromise({ try: () => Promise.resolve(), catch: () => 'failure' }).pipe(Effect.timeoutOrElse({ duration: '1 second', orElse: () => Effect.void }));
  }).pipe(Effect.provideService(Clock.Clock, clock));
  server.serve(endpoint);
  return yield* Artifacts;
});
const infrastructure = Layer.effect(Infrastructure, acquire().pipe(Effect.provideService(Clock.Clock, defaultNativeClock))).pipe(Layer.provideMerge(artifacts), Layer.provide(nativeServices));
const firstLine = Effect.fn('firstLine')(function* firstLine(stream) {
  return yield* Stream.runHead(stream).pipe(Effect.timeoutOrElse({ duration: '1 second', orElse: () => Effect.void }), Effect.mapError(() => 'failure'));
});
const exchange = (clock, owner) => Effect.gen(function* receiveReply() {
  return yield* Effect.timeoutOrElse(owner.next, { duration: '1 second', orElse: () => Effect.void });
}).pipe(Effect.provideService(Clock.Clock, clock));
const journey = Effect.fn('journey')(function* journey() {
  const clock = yield* Clock.Clock;
  yield* clock.sleep(duration);
  yield* firstLine(stream);
  yield* exchange(clock, owner);
});
it.layer(infrastructure, { excludeTestServices: true, timeout: '60 seconds' })('actual nested infrastructure', (suite) => {
  suite.effect('native journey', () => journey().pipe(Effect.scoped, Effect.provide(nativeServices)), 30000);
});`;

it('proves actual nested native setup and consumed whole-Clock timer boundaries', () => {
  expectTimerFixtures([
    { expected: 0, name: 'nested-native-actual-boundaries', source: nestedNativeLayerSource },
    {
      expected: 4,
      name: 'nested-native-ordinary-owner',
      source: nestedNativeLayerSource.replace(excludedLayerServices, 'excludeTestServices: false'),
    },
    {
      expected: 0,
      name: 'nested-native-explicit-clock-isolates-unknown-dependency',
      source: nestedNativeLayerSource.replace('Layer.provide(nativeServices)', 'Layer.provide(unknownServices)'),
    },

    {
      expected: 1,
      name: 'nested-native-exported-acquisition',
      source: nestedNativeLayerSource.replace('const acquire = Effect.fn', 'export const acquire = Effect.fn'),
    },
    {
      expected: 1,
      name: 'nested-native-exported-command-helper',
      source: nestedNativeLayerSource.replace(
        'const commandOutput = Effect.fn',
        'export const commandOutput = Effect.fn',
      ),
    },
    {
      expected: 2,
      name: 'nested-native-fake-layer-receiver',
      source: nestedNativeLayerSource.replace('Layer.effect(Infrastructure,', 'foreign.effect(Infrastructure,'),
    },
    {
      expected: 2,
      name: 'nested-native-unknown-layer-transform',
      source: nestedNativeLayerSource.replace('Layer.provideMerge(artifacts)', 'unknownTransform(artifacts)'),
    },
    {
      expected: 2,
      name: 'nested-native-escaped-layer',
      source: `${nestedNativeLayerSource}\nconsume(infrastructure);`,
    },
    {
      expected: 2,
      name: 'nested-native-escaped-layer-alias',
      source: `${nestedNativeLayerSource}\nconst sharedLayer = infrastructure; consume(sharedLayer);`,
    },
    {
      expected: 2,
      name: 'nested-native-mixed-layer-consumers',
      source: `${nestedNativeLayerSource}\nit.layer(infrastructure)((ordinarySuite) => { ordinarySuite.effect('ordinary', () => Effect.void); });`,
    },
    {
      expected: 1,
      name: 'nested-native-computed-clock-sleep',
      source: nestedNativeLayerSource.replace(nativeClockSleepCall, "clock['sleep'](duration)"),
    },
    {
      expected: 1,
      name: 'nested-native-optional-clock-sleep',
      source: nestedNativeLayerSource.replace(nativeClockSleepCall, 'clock.sleep?.(duration)'),
    },
    {
      expected: 1,
      name: 'nested-native-clock-sleep-arity',
      source: nestedNativeLayerSource.replace(nativeClockSleepCall, 'clock.sleep(duration, extra)'),
    },
    {
      expected: 1,
      name: 'nested-native-opaque-pipe',
      source: nestedNativeLayerSource.replace(
        "Effect.timeoutOrElse(owner.next, { duration: '1 second', orElse: () => Effect.void })",
        "owner.next.pipe(Effect.timeoutOrElse({ duration: '1 second', orElse: () => Effect.void }))",
      ),
    },
    {
      expected: 1,
      name: 'nested-native-leaked-transform',
      source: nestedNativeLayerSource
        .replace('return yield* Effect.timeoutOrElse(owner.next,', 'return Effect.timeoutOrElse(')
        .replace('orElse: () => Effect.void });\n}).pipe', 'orElse: () => Effect.void });\n}).pipe'),
    },
    {
      expected: 1,
      name: 'nested-native-clock-sleep-alias',
      source: nestedNativeLayerSource.replace(
        'yield* clock.sleep(duration);',
        'const sleep = clock.sleep; yield* sleep(duration);',
      ),
    },
    {
      expected: 1,
      name: 'nested-native-clock-sleep-mutation',
      source: nestedNativeLayerSource.replace('yield* clock.sleep(duration);', 'clock.sleep = fakeSleep;'),
    },
    {
      expected: 1,
      name: 'nested-native-fake-map-error',
      source: nestedNativeLayerSource.replace("Effect.mapError(() => 'failure')", "foreign.mapError(() => 'failure')"),
    },
  ]);
});

const defaultClockCallbackSource = `import { Clock, Effect } from 'effect';
import { it } from 'effect-rstest';
const actualClock = Clock.Clock.defaultValue();
const receive = () => Effect.gen(function* receive() {
  return yield* Effect.timeoutOrElse(owner.next, { duration: '1 second', orElse: () => Effect.void });
}).pipe(Effect.provideService(Clock.Clock, actualClock));
it.live('native receive', () => receive());`;
const defaultClockFactoryMember = 'Clock.Clock.defaultValue()';

const scopedClockProvider = 'Effect.provideService(Clock.Clock, Clock.Clock.defaultValue())';
const outerLayerProvider = 'Effect.provide(outerServices)';
const scopedClockTransforms = `${scopedClockProvider}, Effect.scoped, ${outerLayerProvider}`;
const scopedClockSource = `import { Clock, DateTime, Effect } from 'effect';
import { it } from 'effect-rstest';
const outerServices = unknownLayer;
it.live('native owner observations', () => Effect.gen(function* owner() {
  yield* DateTime.now;
  const nested = Effect.fn('nested')(function* nested() { return yield* DateTime.now; });
  yield* nested();
}).pipe(${scopedClockTransforms}));`;

it('preserves an explicit inner native Clock through scoped execution and an outer Layer only', () => {
  expectTimerFixtures([
    { expected: 0, name: 'scoped-clock-outer-layer', source: scopedClockSource },
    {
      expected: 0,
      name: 'scoped-clock-neutral-transform-before-clock',
      source: scopedClockSource.replace(
        scopedClockTransforms,
        `Effect.scoped, ${scopedClockProvider}, ${outerLayerProvider}`,
      ),
    },
    {
      expected: 2,
      name: 'scoped-clock-inner-unknown-layer',
      source: scopedClockSource.replace(
        scopedClockTransforms,
        `${outerLayerProvider}, ${scopedClockProvider}, Effect.scoped`,
      ),
    },
    {
      expected: 2,
      name: 'scoped-clock-ordinary-registration',
      source: scopedClockSource.replace('it.live', 'it.effect'),
    },
    {
      expected: 2,
      name: 'scoped-clock-optional-inline-factory',
      source: scopedClockSource.replace(defaultClockFactoryMember, 'Clock.Clock.defaultValue?.()'),
    },
    {
      expected: 2,
      name: 'scoped-clock-inline-factory-arguments',
      source: scopedClockSource.replace(defaultClockFactoryMember, 'Clock.Clock.defaultValue(unknownClock)'),
    },
    {
      expected: 2,
      name: 'scoped-clock-inline-factory-shadowed',
      source: scopedClockSource
        .replace('Clock, DateTime', 'Clock as NativeClock, DateTime')
        .replace('const outerServices =', 'const Clock = foreignClock; const outerServices ='),
    },
    {
      expected: 2,
      name: 'scoped-clock-inline-factory-mutated',
      source: `${scopedClockSource}\nClock.Clock.defaultValue = unknownFactory;`,
    },
    {
      expected: 2,
      name: 'scoped-clock-inner-fake-before-outer-real-clock',
      source: scopedClockSource.replace(
        scopedClockProvider,
        `Effect.provideService(Clock.Clock, unknownClock), ${scopedClockProvider}`,
      ),
    },
    {
      expected: 2,
      name: 'scoped-clock-missing-provider',
      source: scopedClockSource
        .replace('it.live', 'it.effect')
        .replace(scopedClockTransforms, `Effect.scoped, ${outerLayerProvider}`),
    },
    {
      expected: 2,
      name: 'scoped-clock-unknown-transform',
      source: scopedClockSource.replace('Effect.scoped,', 'unknownTransform,'),
    },
    {
      expected: 2,
      name: 'scoped-clock-optional-layer-transform',
      source: scopedClockSource.replace(outerLayerProvider, 'Effect.provide?.(outerServices)'),
    },
    {
      expected: 2,
      name: 'scoped-clock-spread-layer-transform',
      source: scopedClockSource.replace(outerLayerProvider, 'Effect.provide(...outerServices)'),
    },
    {
      expected: 2,
      name: 'scoped-clock-mutated-effect-namespace',
      source: `${scopedClockSource}\nEffect.scoped = unknownTransform;`,
    },
    {
      expected: 1,
      name: 'scoped-clock-does-not-cover-earlier-acquisition',
      source: `import { Clock, DateTime, Effect } from 'effect';
import { it } from 'effect-rstest';
const outerServices = unknownLayer;
const acquire = () => Effect.gen(function* acquisition() { yield* DateTime.now; });
it.effect('earlier acquisition', () => acquire());
it.live('later provided execution', () => Effect.gen(function* provided() {
  yield* DateTime.now;
}).pipe(${scopedClockTransforms}));`,
    },
  ]);
});

it.effect('an inner Clock provider wins across scoped execution and an outer Clock Layer', () =>
  Effect.gen(function* verifyScopedLayerClockPrecedence() {
    const actualClock = yield* TestClock.make();
    const innerClock = { ...actualClock, currentTimeMillis: Effect.succeed(1000), currentTimeMillisUnsafe: () => 1000 };
    const outerClock = { ...actualClock, currentTimeMillis: Effect.succeed(2000), currentTimeMillisUnsafe: () => 2000 };
    const outerLayer = Layer.succeed(Clock.Clock, outerClock);
    expect(
      yield* Clock.currentTimeMillis.pipe(
        Effect.provideService(Clock.Clock, innerClock),
        Effect.scoped,
        Effect.provide(outerLayer),
      ),
    ).toBe(1000);
    expect(
      yield* Clock.currentTimeMillis.pipe(
        Effect.provide(outerLayer),
        Effect.scoped,
        Effect.provideService(Clock.Clock, innerClock),
      ),
    ).toBe(2000);
  }),
);

it('requires the exact immutable public default Clock factory and a fully consumed native timer', () => {
  expectTimerFixtures([
    { expected: 0, name: 'default-clock-exact-factory', source: defaultClockCallbackSource },
    {
      expected: 1,
      name: 'default-clock-ordinary-owner',
      source: defaultClockCallbackSource.replace('it.live', 'it.effect'),
    },
    {
      expected: 1,
      name: 'default-clock-mixed-owner',
      source: `${defaultClockCallbackSource}\nit.effect('ordinary', () => receive());`,
    },
    {
      expected: 1,
      name: 'default-clock-computed-key',
      source: defaultClockCallbackSource.replace(defaultClockFactoryMember, "Clock['Clock'].defaultValue()"),
    },
    {
      expected: 1,
      name: 'default-clock-unknown-factory',
      source: defaultClockCallbackSource.replace(defaultClockFactoryMember, 'unknownFactory()'),
    },
    {
      expected: 1,
      name: 'default-clock-fake-namespace',
      source: defaultClockCallbackSource.replace(defaultClockFactoryMember, 'ForeignClock.Clock.defaultValue()'),
    },
    {
      expected: 1,
      name: 'default-clock-factory-arguments',
      source: defaultClockCallbackSource.replace(defaultClockFactoryMember, 'Clock.Clock.defaultValue(fake)'),
    },
    {
      expected: 1,
      name: 'default-clock-factory-optional',
      source: defaultClockCallbackSource.replace(defaultClockFactoryMember, 'Clock.Clock.defaultValue?.()'),
    },
    {
      expected: 1,
      name: 'default-clock-factory-alias',
      source: defaultClockCallbackSource
        .replace('const actualClock =', 'const factory = Clock.Clock.defaultValue; const actualClock =')
        .replace(defaultClockFactoryMember, 'factory()'),
    },
    {
      expected: 1,
      name: 'default-clock-factory-mutated',
      source: `${defaultClockCallbackSource}\nClock.Clock.defaultValue = unknownFactory;`,
    },
    { expected: 1, name: 'default-clock-key-escaped', source: `${defaultClockCallbackSource}\nconsume(Clock.Clock);` },

    {
      expected: 1,
      name: 'default-clock-value-exported',
      source: defaultClockCallbackSource.replace('const actualClock =', 'export const actualClock ='),
    },
    {
      expected: 1,
      name: 'default-clock-value-escaped',
      source: `${defaultClockCallbackSource}\nconsume(actualClock);`,
    },
    {
      expected: 1,
      name: 'default-clock-partial-provider',
      source: defaultClockCallbackSource
        .replace('it.live', 'it.effect')
        .replace('}).pipe(Effect.provideService(Clock.Clock, actualClock));', '});'),
    },
    {
      expected: 1,
      name: 'default-clock-opaque-fake-pipe',
      source: defaultClockCallbackSource.replace(
        "Effect.timeoutOrElse(owner.next, { duration: '1 second', orElse: () => Effect.void })",
        "owner.next.pipe(Effect.timeoutOrElse({ duration: '1 second', orElse: () => Effect.void }))",
      ),
    },
  ]);
});

it('proves consumed directly provided sleep only in genuine live owners', () => {
  const source = `import { Clock, Effect, Layer } from 'effect';
import { it } from 'effect-rstest';
const defaultNativeClock = Clock.Clock.defaultValue();
const wait = Effect.fn('wait')(function* wait() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    yield* Effect.sleep('250 millis').pipe(Effect.provideService(Clock.Clock, defaultNativeClock));
  }
});
it.layer(Layer.empty, { excludeTestServices: true })((suite) => {
  suite.effect('real IO', () => wait());
});`;
  expectTimerFixtures([
    { expected: 0, name: 'provided-sleep-live-fn-loop', source },
    {
      expected: 1,
      name: 'provided-sleep-unknown-clock',
      source: source.replace('Clock.Clock.defaultValue()', 'unknownClock'),
    },
    {
      expected: 1,
      name: 'provided-sleep-mixed-use',
      source: `${source}\nit.effect('virtual execution', () => wait());`,
    },
    {
      expected: 1,
      name: 'provided-sleep-unconsumed',
      source: source.replace('yield* Effect.sleep', 'Effect.sleep'),
    },
    {
      expected: 1,
      name: 'provided-sleep-optional-call',
      source: source.replace('Effect.sleep(', 'Effect.sleep?.('),
    },
    {
      expected: 1,
      name: 'provided-sleep-computed-call',
      source: source.replace('Effect.sleep(', "Effect['sleep']("),
    },
    {
      expected: 1,
      name: 'provided-sleep-mutated-clock',
      source: `${source}\nClock.Clock.defaultValue = unknownFactory;`,
    },
    {
      expected: 1,
      name: 'provided-sleep-unknown-inner-service-key',
      source: source.replace(
        'Effect.provideService(Clock.Clock, defaultNativeClock)',
        'Effect.provideService(unknownKey, unknownService), Effect.provideService(Clock.Clock, defaultNativeClock)',
      ),
    },
    {
      expected: 1,
      name: 'provided-sleep-optional-pipe',
      source: source.replace(').pipe(Effect.provideService', ').pipe?.(Effect.provideService'),
    },
    {
      expected: 1,
      name: 'provided-sleep-virtual-layer',
      source: source.replace(
        'it.layer(Layer.empty, { excludeTestServices: true })',
        'it.layer(Layer.empty, { excludeTestServices: false })',
      ),
    },
  ]);
});
