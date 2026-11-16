import { executePriceGroupSourceAssociationsWithAuthorization } from '@app/price-group-catalog/api/client';
import {
  executePriceGroupSourcePricesWithAuthorization,
  executePriceScheduleWithAuthorization,
} from '@app/pricing/api/client';
import { PriceGroupSourcePricesRequestSchema } from '@app/pricing/apis/price-group-source-prices';
import { GatewayForbiddenProblemSchema } from '@app/shared-contracts';
import type { SymmyPriceBatch, SymmyPriceReviseFacts } from '@app/symmy-integration/symmy-internal-contracts';
import { Effect, Option, Redacted, Schema, Stream } from 'effect';

import { symmyUnavailableProblem, symmyUnsupportedProblem } from './contract.ts';
import type { SymmyIngressProblem } from './contract.ts';
import {
  acquireSymmyReadAssertion,
  configuredPriceSource,
  mapSymmyOwnerReadProblem,
  priceGroupCatalogAudience,
  requireRouteRead,
  sourcePricesAreValid,
} from './source-read-projections.ts';
import type { PriceReadSource, SymmySourceReadScope } from './source-read-projections.ts';
import type { SymmyIngressAdmission } from './transport.ts';

type RequestIdentifier = Effect.Effect<string, typeof symmyUnavailableProblem>;
type PriceGroupRef = SymmyPriceBatch['priceGroupRef'];
type PriceRef = SymmyPriceReviseFacts['priceRef'];
type Revise = Extract<SymmyPriceBatch['prices'][number], { readonly operation: 'REVISE' }>;

const pageSize = 100;
const priceGroupModule = 'pricing.price-group-catalog';
const pricingModule = 'commerce.pricing';

/** One answer for a list the key may not write to and a list that does not exist, so no list is revealed. */
const priceListForbidden = GatewayForbiddenProblemSchema.make({
  detail: 'The current route cannot write to the requested price list.',
  status: GatewayForbiddenProblemSchema.fields.status.literal,
  title: 'Gateway context forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});

const sameGroup = (left: PriceGroupRef, right: PriceGroupRef) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/** Every page of a count-bounded read, in order, from offset zero. A page is one stream element. */
const pagesOf = <Page, Failure, Requirements>(
  read: (offset: number) => Effect.Effect<Page, Failure, Requirements>,
  measure: (page: Page) => { readonly count: number; readonly size: number },
) =>
  Stream.paginate(0, (offset: number) =>
    read(offset).pipe(
      Effect.map((page) => {
        const { count, size } = measure(page);
        const next = offset + size;
        return [[page], size === 0 || next >= count ? Option.none<number>() : Option.some(next)] as const;
      }),
    ),
  );

/**
 * A request writes only to a price list this route's own source created: one that has a source association with
 * the route's issuer, namespace and source route. Any other ref, existing or not, is refused alike.
 */
const requireSourcedPriceGroup = Effect.fn('SymmyPriceBatch.requireSourcedGroup')(function* sourcedGroup(
  scope: SymmySourceReadScope,
  priceGroupRef: PriceGroupRef,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
) {
  yield* requireRouteRead(scope, priceGroupModule, 'pricing.price-group-catalog.api.price-group-source-associations');
  const readAssociations = Effect.fn('SymmyPriceBatch.readAssociations')(function* readAssociations(offset: number) {
    const assertion = yield* acquireSymmyReadAssertion(admission, priceGroupCatalogAudience);
    return yield* executePriceGroupSourceAssociationsWithAuthorization(
      {
        issuer: scope.issuerId,
        limit: pageSize,
        namespace: scope.sourceNamespace,
        offset,
        routeId: scope.sourceRouteId ?? scope.routeId,
      },
      `Bearer ${Redacted.value(assertion.assertion)}`,
      yield* newRequestIdentifier,
      { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
    ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
  });
  const sourced = yield* pagesOf(readAssociations, ({ associations, count }) => ({
    count,
    size: associations.length,
  })).pipe(
    Stream.filter(({ associations }) =>
      associations.some((association) => sameGroup(association.priceGroupRef, priceGroupRef)),
    ),
    Stream.runHead,
  );
  yield* Option.match(sourced, { onNone: () => Effect.fail(priceListForbidden), onSome: () => Effect.void });
});

interface CurrentSchedule {
  readonly effectivePeriod: SymmyPriceReviseFacts['effectivePeriod'];
  readonly revisionId: string;
  readonly scheduleRevision: SymmyPriceReviseFacts['scheduleRevision'];
  readonly unitBasis: SymmyPriceReviseFacts['unitBasis'];
}

/** The current schedule position of a price, or none when the owner holds no current revision of it. */
const readCurrentSchedule = Effect.fn('SymmyPriceBatch.currentSchedule')(function* currentSchedule(
  priceRef: PriceRef,
  source: PriceReadSource,
  admission: SymmyIngressAdmission,
  newRequestIdentifier: RequestIdentifier,
) {
  const assertion = yield* acquireSymmyReadAssertion(admission, 'pricing', source.legalEntityId);
  const result = yield* executePriceScheduleWithAuthorization(
    { priceRef },
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* newRequestIdentifier,
    { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
  ).pipe(
    Effect.map(Option.some),
    Effect.catchTag('PriceScheduleNotFoundProblem', () => Effect.succeed(Option.none())),
    Effect.mapError(mapSymmyOwnerReadProblem),
  );
  if (
    Option.isNone(result) ||
    (result.value.outcome !== 'PRICE_SCHEDULE_CURRENT' && result.value.outcome !== 'PRICE_SCHEDULE_GAP')
  ) {
    return Option.none<CurrentSchedule>();
  }
  const { current, priceRef: scheduled, scheduleRevision } = result.value.schedule;
  return current === undefined || scheduled.tenantId !== source.tenantId || scheduled.resourceId !== priceRef.resourceId
    ? Option.none<CurrentSchedule>()
    : Option.some<CurrentSchedule>({
        effectivePeriod: current.effectivePeriod,
        revisionId: current.definition.revision.revisionId,
        scheduleRevision,
        unitBasis: current.definition.identityKey.unitBasis,
      });
});

interface CurrentSource {
  readonly revisionId: string;
  readonly sourceAssertionId: SymmyPriceReviseFacts['currentSourceAssertionId'];
  readonly sourceRecordRef: SymmyPriceReviseFacts['sourceRecordRef'];
}

/** The source record and assertion each price of the list is current with, found by paging its source prices. */
const readCurrentSources = Effect.fn('SymmyPriceBatch.currentSources')(function* currentSources(
  context: {
    readonly admission: SymmyIngressAdmission;
    readonly priceGroupRef: PriceGroupRef;
    readonly scope: SymmySourceReadScope;
    readonly source: PriceReadSource;
  },
  newRequestIdentifier: RequestIdentifier,
) {
  const { admission, priceGroupRef, scope, source } = context;
  const readPrices = Effect.fn('SymmyPriceBatch.readSourcePrices')(function* readPrices(offset: number) {
    const assertion = yield* acquireSymmyReadAssertion(admission, 'pricing', source.legalEntityId);
    const input = yield* Schema.decodeUnknownEffect(PriceGroupSourcePricesRequestSchema)({
      limit: pageSize,
      offset,
      priceGroupRef,
      sourceSystem: source.sourceSystem,
    }).pipe(Effect.catchTag('SchemaError', () => Effect.fail(symmyUnavailableProblem)));
    const page = yield* executePriceGroupSourcePricesWithAuthorization(
      input,
      `Bearer ${Redacted.value(assertion.assertion)}`,
      yield* newRequestIdentifier,
      { baseUrl: assertion.apiBaseUrl, compositionRevision: assertion.compositionRevision },
    ).pipe(Effect.mapError(mapSymmyOwnerReadProblem));
    return sourcePricesAreValid(page, input, scope) ? page : yield* Effect.fail(symmyUnavailableProblem);
  });
  const pages = yield* pagesOf(readPrices, ({ count, prices }) => ({ count, size: prices.length })).pipe(
    Stream.runCollect,
  );
  return new Map<string, CurrentSource>(
    pages.flatMap(({ prices }) =>
      prices.flatMap(({ price, provenance }) =>
        price.outcome === 'PRICE_DEFINITION_CURRENT' && provenance !== undefined
          ? [
              [
                price.definition.priceRef.resourceId,
                {
                  revisionId: provenance.canonicalLink.revisionId,
                  sourceAssertionId: provenance.evidence.sourceAssertion.sourceAssertionId,
                  sourceRecordRef: provenance.evidence.sourceAssertion.sourceRecord.sourceRecordRef,
                },
              ] as const,
            ]
          : [],
      ),
    ),
  );
});

export interface PriceBatchFactsInput {
  readonly admission: SymmyIngressAdmission;
  readonly batch: SymmyPriceBatch;
  /** The read scope of the price list route. Only it can prove the owner price reads, a write route cannot. */
  readonly priceReadScope: Effect.Effect<SymmySourceReadScope, SymmyIngressProblem>;
  /** The scope of the prices route: the issuer, namespace and source route of the lists it may write to. */
  readonly routeScope: SymmySourceReadScope;
}

/**
 * Authorizes the price list of a request and reads what the owner holds about each REVISE price: its schedule
 * position and the source record it was last written with. A price the owner answers nothing for, such as one
 * that does not exist or one of another list, has no facts and ends not accepted for its item. A REVISE needs the
 * price list read route of the key (403 without it) and its price read source (422 without it).
 */
export const readSymmyPriceBatchFacts = Effect.fn('SymmyPriceBatch.facts')(function* batchFacts(
  input: PriceBatchFactsInput,
  newRequestIdentifier: RequestIdentifier,
): Effect.fn.Return<readonly SymmyPriceReviseFacts[], SymmyIngressProblem> {
  const { admission, batch, priceReadScope, routeScope } = input;
  const { priceGroupRef, prices } = batch;
  yield* requireSourcedPriceGroup(routeScope, priceGroupRef, admission, newRequestIdentifier);
  const revises = prices.filter((price): price is Revise => price.operation === 'REVISE');
  if (revises.length === 0) {
    return [];
  }
  const scope = yield* priceReadScope;
  yield* requireRouteRead(scope, pricingModule, 'commerce.pricing.api.price-schedule');
  yield* requireRouteRead(scope, pricingModule, 'commerce.pricing.api.price-group-source-prices');
  const source = yield* configuredPriceSource(scope);
  if (Option.isNone(source)) {
    return yield* Effect.fail(symmyUnsupportedProblem('projection_not_configured'));
  }
  const schedules = yield* Effect.forEach(
    revises,
    ({ priceRef }) => readCurrentSchedule(priceRef, source.value, admission, newRequestIdentifier),
    { concurrency: 1 },
  );
  const sources = yield* readCurrentSources(
    { admission, priceGroupRef, scope, source: source.value },
    newRequestIdentifier,
  );
  return revises.flatMap(({ priceRef }, index) => {
    const schedule = schedules[index];
    const current = sources.get(priceRef.resourceId);
    return schedule !== undefined &&
      Option.isSome(schedule) &&
      current !== undefined &&
      current.revisionId === schedule.value.revisionId
      ? [
          {
            currentSourceAssertionId: current.sourceAssertionId,
            effectivePeriod: schedule.value.effectivePeriod,
            priceRef,
            scheduleRevision: schedule.value.scheduleRevision,
            sourceRecordRef: current.sourceRecordRef,
            unitBasis: schedule.value.unitBasis,
          },
        ]
      : [];
  });
});
