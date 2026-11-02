// The four market commands of apply-command. They run inside the company's write transaction (head row locked by the
// caller) directly against the market tables: they never touch catalog rows, so they neither load a working set nor
// advance the catalog head revision. Decisions are pure (`planConfigureMarket`, `isMarketException`) for unit tests.
import { Effect, Match, Option, Schema } from 'effect';
import type { DateTime } from 'effect';
import {
  merchandiseMarketCommandSchemas,
  MerchandiseNotFound,
  MerchandiseRevisionConflict,
} from '../../shared/actions/apply-command.ts';
import { isMarketException, normalizeExchangeRate, offeredByDefault } from '../../shared/domain/market-offers.ts';
import { EntityIdSchema } from '../../shared/domain/merchandise-model.ts';
import {
  deleteExceptionsEqualTo,
  deleteMarket,
  existingProductIds,
  loadMarket,
  writeMarketSettings,
  writeOffers,
} from './market-store.ts';
import type { StoredMarket } from './market-store.ts';
import type { MerchandiseDb, MerchandiseStoreFailure, StoreScope } from './merchandise-store.ts';

const MarketCommandSchema = Schema.Union(merchandiseMarketCommandSchemas);
export type MarketCommand = typeof MarketCommandSchema.Type;

export const isMarketCommand = Schema.is(MarketCommandSchema);

type ConfigureMarket = Extract<MarketCommand, { readonly _tag: 'ConfigureMarket' }>;
type RemoveMarket = Extract<MarketCommand, { readonly _tag: 'RemoveMarket' }>;
type SetMarketProductOffers = Extract<MarketCommand, { readonly _tag: 'SetMarketProductOffers' }>;
type SetProductMarketOffer = Extract<MarketCommand, { readonly _tag: 'SetProductMarketOffer' }>;

export type ConfigureMarketPlan =
  | { readonly kind: 'conflict' }
  | { readonly kind: 'unchanged'; readonly revision: number }
  | {
      /** Exceptions holding this value equal the new mode's default and are dropped (offer mode changed). */
      readonly dropExceptions: Option.Option<boolean>;
      readonly kind: 'write';
      readonly revision: number;
    };

/**
 * ConfigureMarket against the stored market: `expectedRevision` (0 = must not exist) must match when given; an
 * identical configuration writes nothing; a changed offer mode drops the exceptions that became its default.
 */
export const planConfigureMarket = (
  existing: Option.Option<StoredMarket>,
  command: ConfigureMarket,
): ConfigureMarketPlan => {
  const current = Option.match(existing, { onNone: () => 0, onSome: (market) => market.revision });
  if (command.expectedRevision !== undefined && command.expectedRevision !== current) {
    return { kind: 'conflict' };
  }
  return Option.match(existing, {
    onNone: (): ConfigureMarketPlan => ({ dropExceptions: Option.none(), kind: 'write', revision: 1 }),
    onSome: (market): ConfigureMarketPlan => {
      const same =
        market.marketCode === command.marketCode &&
        market.offerMode === command.offerMode &&
        market.currency === command.currency &&
        market.exchangeRate === normalizeExchangeRate(command.exchangeRate) &&
        market.roundingMinor === command.roundingMinor;
      if (same) {
        return { kind: 'unchanged', revision: market.revision };
      }
      return {
        dropExceptions:
          market.offerMode === command.offerMode ? Option.none() : Option.some(offeredByDefault(command.offerMode)),
        kind: 'write',
        revision: market.revision + 1,
      };
    },
  });
};

const marketNotFound = () =>
  new MerchandiseNotFound({ code: 'merchandise_not_found', reason: 'Market is not configured' });
const productNotFound = (count: number) =>
  new MerchandiseNotFound({
    code: 'merchandise_not_found',
    reason: count === 1 ? 'Product does not exist' : `${count} products do not exist`,
  });

export interface MarketCommandResult {
  readonly entityIds: readonly (typeof EntityIdSchema.Type)[];
  readonly marketRevision?: number;
}

const requiredMarket = Effect.fn('MarketCommands.requiredMarket')(function* requiredMarket(
  db: MerchandiseDb,
  scope: StoreScope,
  marketId: string,
) {
  const market = yield* loadMarket(db, scope, marketId);
  return yield* Effect.fromOption(market).pipe(
    Effect.catchTag('NoSuchElementError', () => Effect.fail(marketNotFound())),
  );
});

const setOffers = Effect.fn('MarketCommands.setOffers')(function* setOffers(
  db: MerchandiseDb,
  scope: StoreScope,
  input: {
    readonly marketId: string;
    readonly now: DateTime.Utc;
    readonly offered: boolean;
    readonly productIds: readonly string[];
  },
) {
  const market = yield* requiredMarket(db, scope, input.marketId);
  const existing = yield* existingProductIds(db, scope, input.productIds);
  const missing = new Set(input.productIds.filter((id) => !existing.has(id)));
  if (missing.size > 0) {
    return yield* productNotFound(missing.size);
  }
  yield* writeOffers(db, scope, {
    marketId: market.marketId,
    now: input.now,
    offered: input.offered,
    productIds: input.productIds,
    store: isMarketException(market.offerMode, input.offered),
  });
  return market;
});

/** Runs one market command in the caller's locked company transaction. */
export const applyMarketCommand = Effect.fn('MarketCommands.apply')(function* applyMarketCommand(
  db: MerchandiseDb,
  scope: StoreScope,
  command: MarketCommand,
  now: DateTime.Utc,
): Effect.fn.Return<MarketCommandResult, MerchandiseNotFound | MerchandiseRevisionConflict | MerchandiseStoreFailure> {
  const entity = yield* Schema.decodeEffect(EntityIdSchema)(command.marketId).pipe(Effect.orDie);
  return yield* Match.value(command).pipe(
    Match.tagsExhaustive({
      ConfigureMarket: Effect.fn('MarketCommands.configure')(function* configure(value: ConfigureMarket) {
        const existing = yield* loadMarket(db, scope, value.marketId);
        const plan = planConfigureMarket(existing, value);
        if (plan.kind === 'conflict') {
          return yield* new MerchandiseRevisionConflict({
            code: 'merchandise_revision_conflict',
            reason: 'The market settings changed; refresh before another change',
          });
        }
        if (plan.kind === 'write') {
          yield* writeMarketSettings(db, scope, { ...value, revision: plan.revision }, now);
          if (Option.isSome(plan.dropExceptions)) {
            yield* deleteExceptionsEqualTo(db, scope, value.marketId, plan.dropExceptions.value);
          }
        }
        return { entityIds: [entity], marketRevision: plan.revision } satisfies MarketCommandResult;
      }),
      RemoveMarket: Effect.fn('MarketCommands.remove')(function* remove(value: RemoveMarket) {
        yield* requiredMarket(db, scope, value.marketId);
        yield* deleteMarket(db, scope, value.marketId);
        return { entityIds: [entity] } satisfies MarketCommandResult;
      }),
      SetMarketProductOffers: Effect.fn('MarketCommands.setMany')(function* setMany(value: SetMarketProductOffers) {
        yield* setOffers(db, scope, { ...value, now });
        return { entityIds: [entity] } satisfies MarketCommandResult;
      }),
      SetProductMarketOffer: Effect.fn('MarketCommands.setOne')(function* setOne(value: SetProductMarketOffer) {
        yield* setOffers(db, scope, {
          marketId: value.marketId,
          now,
          offered: value.offered,
          productIds: [value.productId],
        });
        return { entityIds: [entity] } satisfies MarketCommandResult;
      }),
    }),
  );
});
