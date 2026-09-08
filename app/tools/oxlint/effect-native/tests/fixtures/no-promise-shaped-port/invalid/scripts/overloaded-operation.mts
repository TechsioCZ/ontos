// expect-count: 2
import { Effect } from 'effect';
export function execute(): Promise<number>;
export function execute(): Effect.Effect<number>;
export function execute(): Promise<number> | Effect.Effect<number> { return Effect.succeed(1); }
