import { Context as Ctx, Effect as Fx, Layer as L } from 'effect';

// A provided value's explicit contract is local proof; no inferred cross-file equivalence.
export interface SessionService { load(): Fx.Effect<string>; }
const value: SessionService = { load: () => Fx.succeed('session') };
const tag = Ctx.GenericTag<unknown>('session');
const succeed = L[`succeed`];
export const live = succeed(tag, value);

// Scope-resolved local alias chains also connect the contract.
export namespace Named {
  export interface LookupService { lookup(): Fx.Effect<string>; }
  type Alias = LookupService;
  const service = Ctx[`Service`];
  export class Lookup extends service<Lookup, Alias>()('lookup') {}
}

// ReturnType shadow is data syntax, not the built-in utility.
export namespace Data {
  type ReturnType<A> = { value: A };
  declare const build: () => string;
  export type LocalService = ReturnType<typeof build>;
}
