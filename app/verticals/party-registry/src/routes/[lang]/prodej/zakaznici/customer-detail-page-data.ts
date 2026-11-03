import { Data, DateTime, Effect, Option, Predicate, Random, Result, Schema } from 'effect';
import { definePageData, modulePagePreload, pageDataScopeKey } from '@app/shared-contracts/page-data';
import type { ModulePageContext, ModulePageProps, PageDataSnapshot } from '@app/shared-contracts/page-data';

import { executeCounterpartyRead } from '../../../../api/counterparty-read-client.ts';
import { executePartyContactPoints } from '../../../../api/party-contact-points-client.ts';
import { executePartyDetail } from '../../../../api/party-detail-client.ts';
import { executePartyOfficialIdentifierHistory } from '../../../../api/party-official-identifier-history-client.ts';
import { browserRuntime } from '../../../../runtime/browser-effect-runtime.ts';
import type { CounterpartyReadResponse } from '../../../../../shared/apis/counterparty-read.ts';
import type { PartyContactPointsResponse } from '../../../../../shared/apis/party-contact-points.ts';
import type { PartyDetailResponse } from '../../../../../shared/apis/party-detail.ts';
import type { PartyOfficialIdentifierHistoryResponse } from '../../../../../shared/apis/party-official-identifier-history.ts';
import type { CounterpartyRef } from '../../../../../shared/resources/counterparty.ts';
import type { CustomerSection } from './customers-data.ts';

/** The complete owner read a direct link can prove without consulting the bounded customer list. */
export interface CustomerDetailPageRecord {
  readonly contacts: CustomerSection<PartyContactPointsResponse>;
  readonly counterparty: CounterpartyReadResponse;
  readonly identifiers: CustomerSection<PartyOfficialIdentifierHistoryResponse>;
  readonly identity: CustomerSection<PartyDetailResponse>;
  readonly now: DateTime.Utc;
}

/**
 * A direct link is readable only for the signed-in principal's selected Legal Entity and a current CUSTOMER role.
 * A refusal and a transient failure both drop the record: no previous authorized snapshot is ever reused.
 */
export class CustomerDetailPageFailure extends Data.TaggedError('CustomerDetailPageFailure')<{
  readonly reason: 'forbidden' | 'not-found' | 'unavailable';
}> {}

export type CustomerDetailPageError = CustomerDetailPageFailure;

export interface CustomerDetailPageInput {
  /** Missing Shell identity reads nothing: a shared cache is never keyed without the full scope. */
  readonly context: ModulePageContext | undefined;
  /** The true Counterparty/Customer resource id from the route, never a Party id. */
  readonly counterpartyId: string;
}

/** The route id must be a plausible resource id; a blank or over-long value reads nothing. */
export const customerDetailPageInput = (
  context: ModulePageContext | undefined,
  routeParams: Readonly<Record<string, string>>,
): Option.Option<CustomerDetailPageInput> => {
  const counterpartyId = routeParams['id']?.trim() ?? '';
  return counterpartyId.length === 0 || counterpartyId.length > 300
    ? Option.none()
    : Option.some({ context, counterpartyId });
};

const PageKeySchema = Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String]));

/** Scope plus the exact Counterparty id. A scope change is a different cache entry, never a reused record. */
export const customerDetailPageInputKey = (input: CustomerDetailPageInput): Option.Option<string> => {
  const scope = pageDataScopeKey(input.context, 'party.registry');
  return scope === undefined
    ? Option.none()
    : Option.some(Result.getOrThrow(Schema.encodeResult(PageKeySchema)([scope, input.counterpartyId])));
};

export const CustomerDetailPageStatusSchema = Schema.Literals([
  'forbidden',
  'loading',
  'not-found',
  'ready',
  'unavailable',
]);
export type CustomerDetailPageStatus = typeof CustomerDetailPageStatusSchema.Type;

export const customerDetailPageStatus = (
  input: Option.Option<CustomerDetailPageInput>,
  snapshot: PageDataSnapshot<CustomerDetailPageRecord, CustomerDetailPageError>,
): CustomerDetailPageStatus => {
  if (Option.isNone(input)) {
    return 'not-found';
  }
  if (Option.isNone(customerDetailPageInputKey(input.value))) {
    return 'unavailable';
  }
  if (snapshot.state === 'pending') {
    return 'loading';
  }
  if (snapshot.state === 'ready') {
    return 'ready';
  }
  return snapshot.error.reason;
};

const correlation = (operation: string) =>
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.map(([first, second]) => `party-registry:${operation}:${first}:${second}`),
  );

/** Detail reads retain their individual authorization outcomes. A Counterparty grant never grants Party Read. */
const section = <Value, Failure>(operation: Effect.Effect<Value, Failure>) =>
  operation.pipe(
    Effect.match({
      onFailure: (error): CustomerSection<Value> => ({
        status: Schema.is(Schema.Struct({ status: Schema.Literal(403) }))(error) ? 'forbidden' : 'unavailable',
      }),
      onSuccess: (value): CustomerSection<Value> => ({ status: 'ready', value }),
    }),
  );

const counterpartyFailure = (
  error: Effect.Error<ReturnType<typeof executeCounterpartyRead>>,
): CustomerDetailPageError => {
  if (Predicate.isTagged(error, 'CounterpartyReadForbiddenProblem')) {
    return new CustomerDetailPageFailure({ reason: 'forbidden' });
  }
  if (Predicate.isTagged(error, 'CounterpartyReadNotFoundProblem')) {
    return new CustomerDetailPageFailure({ reason: 'not-found' });
  }
  return new CustomerDetailPageFailure({ reason: 'unavailable' });
};

const sameRef = (left: CounterpartyRef, right: CounterpartyRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/** Only a current, open CUSTOMER role is a customer record for this presentation. */
const hasCurrentCustomerRole = (counterparty: CounterpartyReadResponse): boolean =>
  counterparty.currentRoles.some(
    (role) => role.roleType === 'CUSTOMER' && role.state === 'ACTIVE' && role.validTo === null,
  );

/**
 * Loads the exact Counterparty id from the owner. The list is never an existence gate, so a customer outside its
 * bounded rows still opens, while a Party id, a foreign-company record or a non-customer role is refused as missing.
 */
export const loadCustomerDetailPageRecord = Effect.fn('CustomerDetailPage.load')(function* loadPageRecord(
  input: CustomerDetailPageInput,
) {
  const { context, counterpartyId } = input;
  if (context === undefined) {
    return yield* new CustomerDetailPageFailure({ reason: 'unavailable' });
  }
  const requestedRef: CounterpartyRef = {
    moduleId: 'party.registry',
    resourceId: counterpartyId,
    resourceType: 'party.registry.counterparty',
    tenantId: context.tenantId,
  };
  const id = yield* correlation('customer-detail-page');
  const counterparty = yield* executeCounterpartyRead({ counterpartyRef: requestedRef }, id).pipe(
    Effect.mapError(counterpartyFailure),
  );
  const currentCompany =
    counterparty.legalEntityRef.resourceId === context.legalEntityId &&
    counterparty.legalEntityRef.tenantId === context.tenantId;
  if (
    !sameRef(counterparty.counterpartyRef, requestedRef) ||
    !currentCompany ||
    !hasCurrentCustomerRole(counterparty)
  ) {
    return yield* new CustomerDetailPageFailure({ reason: 'not-found' });
  }
  // Current identity only: fact history needs `review_party_identity`, which read-only roles do not hold.
  const identity = yield* section(executePartyDetail({ partyRef: counterparty.party.canonicalPartyRef }, id));
  const partyRef =
    identity.status === 'ready' ? identity.value.resolution.canonicalPartyRef : counterparty.party.canonicalPartyRef;
  const { contacts, identifiers } = yield* Effect.all(
    {
      contacts: section(executePartyContactPoints({ includeHistorical: true, partyRef }, id)),
      identifiers: section(executePartyOfficialIdentifierHistory({ partyRef }, id)),
    },
    { concurrency: 1 },
  );
  return { contacts, counterparty, identifiers, identity, now: yield* DateTime.now };
});

/** Exact detail keyed by the complete Shell scope and the Counterparty id; a failed revalidation drops the record. */
export const customerDetailPageData = definePageData({
  cancelWhenUnused: true,
  key: (input: CustomerDetailPageInput) =>
    Option.getOrElse(customerDetailPageInputKey(input), () => 'party-registry:customer-detail:unscoped'),
  load: loadCustomerDetailPageRecord,
  maxEntries: 64,
  retainStale: false,
  runtime: browserRuntime,
});

/** The Shell prepares the exact record before it reveals the page. */
export const preloadCustomerDetailPage = modulePagePreload((props: ModulePageProps) =>
  Option.match(customerDetailPageInput(props.context, props.routeParams), {
    onNone: () => Effect.void,
    onSome: (input) =>
      Option.isNone(customerDetailPageInputKey(input)) ? Effect.void : customerDetailPageData.preload(input),
  }),
);
