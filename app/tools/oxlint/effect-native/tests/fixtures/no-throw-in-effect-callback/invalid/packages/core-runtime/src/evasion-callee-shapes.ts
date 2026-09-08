// expect-count: 12
// Adversarial: every callee spelling that still denotes an `effect` combinator. Each of these is the
// same S1/A4 anti-pattern written so the callee is harder to recognise syntactically.
import { Effect as Fx, pipe } from 'effect';
import * as Eff from 'effect';
import * as Layer from 'effect/Layer';
import { tryPromise } from 'effect/Effect';

declare const program: Fx.Effect<number, Error>;
declare const tag: unknown;

// 1 — optional chaining through a root namespace import.
export const a = Eff?.Effect?.gen(function* () { throw new Error('a'); });
// 2 — computed access on a root namespace import.
export const b = Eff['Effect'].gen(function* () { throw new Error('b'); });
// 3 — template-literal computed member.
export const c = Fx[`sync`](() => { throw new Error('c'); });
// 4 — direct member import used as a bare callee.
export const d = tryPromise({ try: async () => { throw new Error('d'); }, catch: (e: unknown) => e });
// 5 — object *method shorthand* inside the `{ try, catch }` bag.
export const e = Fx.tryPromise({ async try() { throw new Error('e'); }, catch: (x: unknown) => x });
// 6 — callback wrapped in `satisfies`.
export const f = Fx.sync((() => { throw new Error('f'); }) satisfies () => never);
// 7 — callback delivered through a spread array argument.
export const g = Fx.sync(...[() => { throw new Error('g'); }]);
// 8 — `new Promise` executor nested inside the `try` callback.
export const h = Fx.tryPromise({ try: () => new Promise<number>(() => { throw new Error('h'); }), catch: (x: unknown) => x });
// 9 — function declaration nested inside `Effect.gen`.
export const i = Fx.gen(function* () { function assert(ok: boolean): void { if (!ok) throw new Error('i'); } assert(true); });
// 10 — class method declared inside an Effect callback.
export const j = Fx.sync(() => { class K { run(): void { throw new Error('j'); } } return new K(); });
// 11 — point-free `pipe` with an aliased namespace.
export const k = pipe(program, Fx.catchAll((error: Error) => { throw error; }));
// 12 — submodule namespace import (`effect/Layer`).
export const l = Layer.effect(tag as never, Fx.sync(() => { throw new Error('l'); }));
