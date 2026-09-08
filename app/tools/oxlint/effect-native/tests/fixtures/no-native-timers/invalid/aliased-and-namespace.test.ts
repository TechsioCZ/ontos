// expect-count: 3
import { Effect as E } from 'effect';
import { sleep } from 'effect/Effect';
import * as Schedule from 'effect/Schedule';

export const policy = Schedule.exponential('10 millis');
export const wait = E['sleep']('1 second');
export const also = sleep('2 seconds');
