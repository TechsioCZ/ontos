// expect-count: 1
import { Effect } from 'effect';
declare const program: never;
switch (process.argv[2]) {
  case 'both':
    await Effect.runPromise(program);
  default:
    await Effect.runPromise(program);
}
