import { Context as Ctx, Effect as Eff } from 'effect';

/** Aliased `Context` import still counts as a tag in this module. */
export interface ScopedTransactionGateway {
  readonly withTransaction: <A>(body: () => Eff.Effect<A>) => Eff.Effect<A>;
}

export class ScopedTransaction extends Ctx.Service<ScopedTransaction, ScopedTransactionGateway>()(
  '@app/core-runtime/db/ScopedTransaction',
) {}
