import type { OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  SourceAdmissionSetRequest,
  SourceAdmissionSetResponse,
} from '../../shared/apis/source-counterparty-admission.ts';
import { makePartyRef, PartyPersistenceUnavailable } from '../../shared/domain/identity-contracts.ts';
import type { PartyPersistenceUnavailableError } from '../../shared/domain/identity-contracts.ts';
import type { PartyTransaction } from '../db/types.ts';
import { authorizePartyClientSourceReferences } from './party-client-source-evidence.service.ts';
import { lockTenantIdentityReads } from './party-identifier-claim.service.ts';
import {
  currentSourceCounterpartyAdmission,
  loadSourceAdmissionCounterparty,
  sourceCounterpartyNotAdmissible,
} from './source-counterparty-admission.service.ts';
import type { SourceAdmissionCounterparty } from './source-counterparty-admission.service.ts';
import {
  currentSourcePersonAdmission,
  loadAuthorizedSourceCorrelatedParties,
  sourcePersonNotAdmissible,
} from './source-person-admission.service.ts';
import type { SourceCorrelatedParty } from './source-person-admission.service.ts';

const unavailable = (cause?: unknown) =>
  Object.assign(
    new PartyPersistenceUnavailable({
      code: 'party_persistence_unavailable',
      reason: 'Current source customer admission is unavailable',
    }),
    { cause },
  );

type Item = SourceAdmissionSetRequest['items'][number];
type Loaded =
  | { readonly kind: 'COUNTERPARTY'; readonly counterparty: SourceAdmissionCounterparty; readonly correlated: SourceCorrelatedParty }
  | { readonly kind: 'PERSON'; readonly correlated: SourceCorrelatedParty }
  | undefined;

/**
 * The current admission of every customer of a source page with the same checks, in the same order, as one
 * Counterparty or PERSON admission each: the pre-target Privacy decisions of every admissible reference in one set
 * call, the exact Counterparty and source correlation under one shared identity lock, the target Privacy decisions of
 * every correlated Counterparty Party in a second set call, then the effective CUSTOMER role or PERSON type. An item
 * its single admission would answer NOT_ADMISSIBLE is NOT_ADMISSIBLE here; any refused or unavailable check fails the
 * whole set, as it fails its single admission.
 */
export const readSourceAdmissionSet = Effect.fn('SourceAdmissionSet.read')(function* readAdmissionSet(
  transaction: Pick<PartyTransaction, 'select'>,
  scope: OperationalScope,
  input: SourceAdmissionSetRequest,
): Effect.fn.Return<SourceAdmissionSetResponse, PartyPersistenceUnavailableError> {
  const { legalEntityId } = scope;
  const admissible = (item: Item): boolean =>
    item.kind === 'COUNTERPARTY'
      ? item.counterpartyRef.tenantId === scope.tenantId && legalEntityId !== undefined
      : item.partyRef.tenantId === scope.tenantId;
  yield* authorizePartyClientSourceReferences(
    input.items
      .filter(admissible)
      .map((item) => ({ assertion: item.sourceReference, intent: { operation: 'EVIDENCE_READ' as const } })),
    scope,
  ).pipe(Effect.mapError(unavailable));
  if (legalEntityId !== undefined && input.items.some((item) => item.kind === 'COUNTERPARTY' && admissible(item))) {
    yield* lockTenantIdentityReads(transaction, scope.tenantId);
  }
  // The exact Counterparty of each admissible company item, then every correlation of the page in one batch.
  const counterparties = yield* Effect.forEach(
    input.items,
    (item) =>
      item.kind === 'COUNTERPARTY' && admissible(item) && legalEntityId !== undefined
        ? loadSourceAdmissionCounterparty(transaction, scope, legalEntityId, item)
        : Effect.succeed(undefined),
    { concurrency: 1 },
  );
  const correlationInputs = input.items.flatMap((item, index) => {
    if (!admissible(item)) {
      return [];
    }
    if (item.kind === 'PERSON') {
      return [{ index, request: item }];
    }
    const counterparty = counterparties[index];
    return counterparty === undefined
      ? []
      : [
          {
            index,
            request: {
              partyRef: makePartyRef(scope.tenantId, counterparty.partyId),
              sourceReference: item.sourceReference,
            },
          },
        ];
  });
  const correlations = yield* loadAuthorizedSourceCorrelatedParties(
    transaction,
    scope,
    correlationInputs.map(({ request }) => request),
  );
  const correlatedByIndex = new Map(correlationInputs.map(({ index }, position) => [index, correlations[position]]));
  const loaded: Loaded[] = input.items.map((item, index) => {
    const correlated = correlatedByIndex.get(index);
    if (correlated === undefined) {
      return undefined;
    }
    if (item.kind === 'PERSON') {
      return { correlated, kind: 'PERSON' };
    }
    const counterparty = counterparties[index];
    return counterparty === undefined ? undefined : { correlated, counterparty, kind: 'COUNTERPARTY' };
  });
  yield* authorizePartyClientSourceReferences(
    input.items.flatMap((item, index) => {
      const current = loaded[index];
      return current?.kind === 'COUNTERPARTY'
        ? [
            {
              assertion: item.sourceReference,
              intent: {
                operation: 'EVIDENCE_READ' as const,
                target: { kind: 'PARTY' as const, partyId: current.correlated.party.partyId },
              },
            },
          ]
        : [];
    }),
    scope,
  ).pipe(Effect.mapError(unavailable));
  const items = yield* Effect.forEach(
    input.items,
    (item, index): Effect.Effect<SourceAdmissionSetResponse['items'][number], PartyPersistenceUnavailableError> => {
      const current = loaded[index];
      if (item.kind === 'PERSON') {
        return current?.kind === 'PERSON'
          ? currentSourcePersonAdmission(transaction, scope, item, current.correlated).pipe(
              Effect.map((result) => ({ kind: 'PERSON' as const, result })),
            )
          : Effect.succeed({ kind: 'PERSON' as const, result: sourcePersonNotAdmissible });
      }
      return current?.kind === 'COUNTERPARTY' && legalEntityId !== undefined
        ? currentSourceCounterpartyAdmission(
            transaction,
            scope,
            legalEntityId,
            item,
            current.counterparty,
            current.correlated.party.revision,
          ).pipe(Effect.map((result) => ({ kind: 'COUNTERPARTY' as const, result })))
        : Effect.succeed({ kind: 'COUNTERPARTY' as const, result: sourceCounterpartyNotAdmissible });
    },
    { concurrency: 1 },
  );
  return { items };
});
