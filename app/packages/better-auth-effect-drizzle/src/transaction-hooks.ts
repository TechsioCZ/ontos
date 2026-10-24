import type { AnyRelations } from 'drizzle-orm';
import type { EffectPgDatabase } from 'drizzle-orm/effect-postgres';
import { Context, Schema } from 'effect';
import type { Effect } from 'effect';

export type EffectDrizzleAuthTransaction = Parameters<Parameters<EffectPgDatabase<AnyRelations>['transaction']>[0]>[0];
export const ConsumedRowSchema = Schema.Record(Schema.String, Schema.Unknown);

/** Runs only for a successful native consume inside its owning transaction; failure rolls everything back. */
export class EffectDrizzleAuthTransactionHooks extends Context.Service<
  EffectDrizzleAuthTransactionHooks,
  {
    readonly afterConsume: (
      transaction: EffectDrizzleAuthTransaction,
      model: string,
      row: typeof ConsumedRowSchema.Type,
    ) => Effect.Effect<void>;
  }
>()('@app/better-auth-effect-drizzle/transaction-hooks/EffectDrizzleAuthTransactionHooks') {}
