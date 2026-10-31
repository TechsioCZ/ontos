import {
  OutboxWorkerLegalEntityScopeFanout,
  ownerResourceModuleContainment,
  ResourceContainmentRelationshipMutation,
} from '@app/core-runtime/outbox/worker';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime/outbox/worker';
import { Effect, Option, Ref, Schema } from 'effect';

import type { MarketHistoryResponse } from '../../shared/apis/market-history.ts';
import { readMarketHistoryWithInvoker } from '../persistence/market-history-routine.ts';

export class MarketResourceContainmentRejected extends Schema.TaggedError<MarketResourceContainmentRejected>()(
  'MarketResourceContainmentRejected',
  {
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

const rejected = (reason: string, retryable = false) => new MarketResourceContainmentRejected({ reason, retryable });

interface OwnedMarket {
  readonly history: MarketHistoryResponse;
  readonly legalEntityId: string;
}

interface OwnerResource {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

const observeOwnedMarket = (
  scope: OutboxWorkerLegalEntityScope,
  marketId: string,
  owners: Ref.Ref<readonly OwnedMarket[]>,
) =>
  readMarketHistoryWithInvoker(scope.routineInvoker, marketId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (history: MarketHistoryResponse) =>
          Ref.update(owners, (current) => [...current, { history, legalEntityId: scope.legalEntityId }]),
      }),
    ),
  );

/**
 * Places Market owner resources in the exact company `commerce.market-catalog` module scope, so the resource-level
 * Action permissions (`resource#write = (writer + module->write_all) & module->access`) resolve for that company's
 * Market administrators. The owner state is read under Core's verified Legal Entity fan-out (RLS confines a Market to
 * its seller's scope); the idempotent SpiceDB TOUCH runs after every scope transaction has closed.
 */
export const projectMarketResourceContainment = Effect.fn('MarketResourceContainment.project')(
  function* projectMarketResourceContainment(
    context: OutboxWorkerHandlerContext,
    marketId: string,
    selectResource: (owned: OwnedMarket) => Option.Option<OwnerResource>,
  ) {
    const fanout = yield* OutboxWorkerLegalEntityScopeFanout;
    const containment = yield* ResourceContainmentRelationshipMutation;
    const owners = yield* Ref.make<readonly OwnedMarket[]>([]);
    yield* fanout.forEachScope(context, (scope) => observeOwnedMarket(scope, marketId, owners));
    const found = yield* Ref.get(owners);
    const [owned] = found;
    if (owned === undefined || found.length !== 1) {
      return yield* rejected('The Market is not owned by exactly one verified Legal Entity scope');
    }
    if (
      owned.history.marketRef.tenantId !== context.tenantId ||
      owned.history.definitions.some(
        ({ sellingLegalEntityRef }) =>
          sellingLegalEntityRef.resourceId !== owned.legalEntityId ||
          sellingLegalEntityRef.tenantId !== context.tenantId,
      )
    ) {
      return yield* rejected('The Market seller does not match its verified Legal Entity scope');
    }
    const resource = selectResource(owned);
    if (Option.isNone(resource)) {
      return yield* rejected('The delivered resource does not match the durable Market owner state');
    }
    const relationship = ownerResourceModuleContainment(context.tenantId, owned.legalEntityId, resource.value);
    if (relationship === undefined) {
      return yield* rejected('The Market resource containment identity is invalid');
    }
    return yield* containment.touch({ relationships: [relationship] });
  },
);
