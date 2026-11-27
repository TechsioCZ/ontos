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
  loadAuthorizedSourceCorrelatedParty,
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
  const loaded = yield* Effect.forEach(
    input.items,
    Effect.fnUntraced(function* load(item): Effect.fn.Return<Loaded, PartyPersistenceUnavailableError> {
      if (!admissible(item)) {
        return undefined;
      }
      if (item.kind === 'PERSON') {
        const correlated = yield* loadAuthorizedSourceCorrelatedParty(transaction, scope, item);
        return correlated === undefined ? undefined : { correlated, kind: 'PERSON' };
      }
      if (legalEntityId === undefined) {
        return undefined;
      }
      const counterparty = yield* loadSourceAdmissionCounterparty(transaction, scope, legalEntityId, item);
      if (counterparty === undefined) {
        return undefined;
      }
      const correlated = yield* loadAuthorizedSourceCorrelatedParty(transaction, scope, {
        partyRef: makePartyRef(scope.tenantId, counterparty.partyId),
        sourceReference: item.sourceReference,
      });
      return correlated === undefined ? undefined : { correlated, counterparty, kind: 'COUNTERPARTY' };
    }),
    { concurrency: 1 },
  );
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
