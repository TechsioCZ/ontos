// expect-count: 3
import { Effect } from 'effect';
const TestClock = { layer: () => ({}) };
const mock = { timers: { enable: () => {} } };
mock.timers.enable();
TestClock.layer();
setTimeout(() => {}, 1);
Effect[`sleep`]('1 second');
(Effect as typeof Effect).timeout(Effect.void, '1 second');
