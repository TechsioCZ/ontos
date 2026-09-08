// expect-count: 1
import { Effect } from 'effect';
declare const program: never;
if (process.argv[2] === 'once') {
  await Effect.runPromise(program);
} else {
  await Effect.runPromise(program);
  await Effect.runPromise(program);
}
