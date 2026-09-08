// Type-only positions never run anything: no report.
import { Effect } from 'effect';
import type { Effect as EffectType } from 'effect';

type Runner = typeof Effect.runPromise;

declare const program: EffectType.Effect<string>;

export type Program = typeof program;

export const describeRunner = (runner: Runner): string => typeof runner;

export type { runEffectRequest } from '../contacts-api.ts';
