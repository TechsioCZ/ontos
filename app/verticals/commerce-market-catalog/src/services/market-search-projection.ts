import {
  CoreSearchIngestion,
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionStore,
  ResourceContainmentRelationshipMutation,
} from '@app/core-runtime';
import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import { ownerResourceModuleContainment } from '@app/core-runtime/outbox/worker';
import { Context, DateTime, Effect, Layer, Schema } from 'effect';

import {
  MARKET_SEARCH_MODULE,
  MARKET_SEARCH_RESOURCE,
  MarketSearchSource,
  marketSearchUnavailable,
} from './market-search-source.ts';
import type { MarketSearchSnapshot, MarketSearchTarget } from './market-search-source.ts';

const marketRef = (tenantId: string, resourceId: string) => ({
  moduleId: MARKET_SEARCH_MODULE,
  resourceId,
  resourceType: MARKET_SEARCH_RESOURCE,
  tenantId,
});

const period = (row: { readonly effectiveFrom: Date; readonly effectiveTo: Date | null }) =>
  row.effectiveTo === null
    ? { validFrom: DateTime.formatIso(DateTime.fromDateUnsafe(row.effectiveFrom)) }
    : {
        validFrom: DateTime.formatIso(DateTime.fromDateUnsafe(row.effectiveFrom)),
        validTo: DateTime.formatIso(DateTime.fromDateUnsafe(row.effectiveTo)),
      };

export const buildMarketSearchDocuments = (snapshot: MarketSearchSnapshot) =>
  Effect.forEach(
    snapshot.records,
    (row) => {
      if (row.tenantId !== snapshot.tenantId) {
        return Effect.fail(marketSearchUnavailable());
      }
      return Schema.decodeUnknownEffect(CoreSearchProjectionDocumentSchema)({
        archived: false,
        facets: [],
        metadata: [],
        projectionVersion: snapshot.projectionVersion,
        ref: marketRef(snapshot.tenantId, row.marketId),
        searchableText: [],
        selectedLegalEntityId: row.sellingLegalEntityId,
        temporalFacets: row.lifecycles.flatMap((lifecycle) =>
          lifecycle.lifecycle === 'ACTIVE' || lifecycle.lifecycle === 'SUSPENDED'
            ? [{ key: 'visible-market', value: 'yes', ...period(lifecycle) }]
            : [],
        ),
        temporalSearchableText: row.definitions.map((definition) => ({
          value: definition.purpose,
          ...period(definition),
        })),
        // The business code is the stable human-facing Market label, not its opaque technical resource ID.
        title: row.businessCode,
      }).pipe(Effect.mapError(marketSearchUnavailable));
    },
    { concurrency: 1 },
  );

export const makeMarketSearchProjector = Effect.gen(function* makeMarketSearchProjector() {
  const source = yield* MarketSearchSource;
  const ingestion = yield* CoreSearchIngestion;
  const store = yield* CoreSearchProjectionStore;
  const containment = yield* ResourceContainmentRelationshipMutation;
  return {
    project: Effect.fn('MarketSearchProjector.project')(function* projectMarketSearch(
      context: OutboxWorkerHandlerContext,
      target: MarketSearchTarget,
    ) {
      const snapshot = yield* source.load(context, target);
      if (
        snapshot.tenantId !== context.tenantId ||
        !/^[1-9][0-9]*$/u.test(snapshot.projectionVersion) ||
        new Set(snapshot.records.map(({ marketId }) => marketId)).size !== snapshot.records.length ||
        ('marketId' in target && snapshot.records.some(({ marketId }) => marketId !== target.marketId))
      ) {
        return yield* marketSearchUnavailable();
      }
      const documents = yield* buildMarketSearchDocuments(snapshot);
      // The Core snapshot has closed its SQL transaction before any containment or index write.
      yield* Effect.forEach(
        documents,
        Effect.fn('MarketSearchProjector.placeMarketInCompany')(function* placeMarketInCompany(document) {
          const company = document.selectedLegalEntityId;
          const relationship =
            company === undefined ? undefined : ownerResourceModuleContainment(context.tenantId, company, document.ref);
          if (relationship === undefined) {
            return yield* marketSearchUnavailable();
          }
          return yield* containment
            .touch({ relationships: [relationship] })
            .pipe(Effect.mapError(marketSearchUnavailable));
        }),
        { concurrency: 1 },
      );
      if ('rebuild' in target) {
        return yield* store
          .replace(
            {
              documents,
              moduleId: MARKET_SEARCH_MODULE,
              rebuildVersion: snapshot.projectionVersion,
              resourceType: MARKET_SEARCH_RESOURCE,
              tenantId: context.tenantId,
            },
            context,
          )
          .pipe(Effect.mapError(marketSearchUnavailable));
      }
      const [document] = documents;
      return yield* ingestion
        .ingest(
          {
            consumerModuleKey: MARKET_SEARCH_MODULE,
            mutation:
              document === undefined
                ? {
                    kind: 'delete',
                    projectionVersion: snapshot.projectionVersion,
                    ref: marketRef(context.tenantId, target.marketId),
                  }
                : { document, kind: 'upsert' },
            producerModuleKey: context.producerModuleKey,
            projectionVersion: snapshot.projectionVersion,
            tenantId: context.tenantId,
            topic: context.topic,
            workerKey: context.workerKey,
          },
          context,
        )
        .pipe(Effect.mapError(marketSearchUnavailable));
    }),
  };
});

export class MarketSearchProjector extends Context.Service<
  MarketSearchProjector,
  Effect.Success<typeof makeMarketSearchProjector>
>()('@app/commerce-market-catalog/services/market-search-projection/MarketSearchProjector') {}

export const MarketSearchProjectorLive = Layer.effect(MarketSearchProjector, makeMarketSearchProjector);
