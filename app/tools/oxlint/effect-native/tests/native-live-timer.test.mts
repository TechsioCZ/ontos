import { writeFileSync } from 'node:fs';
import nodePath from 'node:path';

import { expect, it } from 'effect-rstest';

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
import { ChildProcess } from 'effect/unstable/process';
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
