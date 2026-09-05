// Identically spelled members and runners that do not come from `effect`: no report.
import { Effect } from '../vendor/effect-lookalike.ts';
import { runPromise, runSync } from '../scheduler.ts';

export const started = Effect.runPromise('job');
export const ticked = runPromise('job');
export const settled = runSync('job');
