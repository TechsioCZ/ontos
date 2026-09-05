// expect-count: 7
// Every spelling of the same Promise bridge that a one-token edit could hide behind.
import { Effect } from 'effect';
import * as Fx from 'effect/Effect';
import * as EffectNs from 'effect';

declare const db: { read: () => Promise<string> };

// 1 — optional member access on the namespace.
export const optionalMember = Effect?.tryPromise(() => db.read());
// 2 — optional call.
export const optionalCall = Effect.tryPromise?.(() => db.read());
// 3 — computed member access.
export const computed = Effect['tryPromise'](() => db.read());
// 4 — computed member on an `effect/Effect` submodule namespace.
export const submoduleComputed = Fx['promise'](async () => await db.read());
// 5 — computed leaf under the root barrel.
export const barrelComputedLeaf = EffectNs.Effect['tryPromise'](() => db.read());
// 6 — computed root under the root barrel.
export const barrelComputedRoot = EffectNs['Effect'].tryPromise(() => db.read());
// 7 — parenthesised callee.
export const parenthesised = (Effect.tryPromise)(() => db.read());
