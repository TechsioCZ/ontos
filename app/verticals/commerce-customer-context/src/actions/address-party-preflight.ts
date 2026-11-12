import { OperationContextUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type {
  ActionServiceFactory,
  ActionServicePreparationContext,
  OperationalScope,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { Crypto, Effect, Schema } from 'effect';

import { AddSavedAddressPayloadSchema, UpdateSavedAddressPayloadSchema } from '../../shared/domain/address-actions.ts';
import type { AddSavedAddressPayload, UpdateSavedAddressPayload } from '../../shared/domain/address-actions.ts';
import { AddressBookUnavailable } from '../../shared/domain/address-errors.ts';
import { readAddressProfileSnapshot } from '../persistence/profile-persistence.ts';
import {
  assertPreparedPartyAddressCurrent,
  partyContactPointExecutorForScope,
  preparePartyAddressSource,
} from '../integrations/party-address-source.ts';
import type { PartyAddressRequirementKey } from '../integrations/party-address-source.ts';
import {
  AddressPreparationSnapshotSchema,
  addressActionPersistenceForTransaction,
  addressPreparationSnapshot,
} from '../persistence/address-persistence.ts';

type Payload = AddSavedAddressPayload | UpdateSavedAddressPayload;
const sameAdd = Schema.toEquivalence(Schema.toType(AddSavedAddressPayloadSchema));
const sameUpdate = Schema.toEquivalence(Schema.toType(UpdateSavedAddressPayloadSchema));
const OwnerSnapshotSchema = Schema.Struct({
  addresses: AddressPreparationSnapshotSchema,
  profiles: Schema.String,
});
const sameSnapshot = Schema.toEquivalence(Schema.toType(OwnerSnapshotSchema));
const samePrincipal = Schema.toEquivalence(TrustedPrincipalContextSchema);

const unavailable = (cause?: unknown) => {
  const failure = new OperationContextUnavailable({
    code: 'operation_context_unavailable',
    reason: 'Prepared Party address evidence no longer matches its invocation or owner state',
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { value: cause });
};
const unavailableSource = () =>
  new AddressBookUnavailable({
    code: 'address_book_unavailable',
    dependency: 'commerce.customer-context.prepared-address',
    retryable: true,
  });

const sameScope = (left: OperationalScope, right: OperationalScope) =>
  samePrincipal(left, right) &&
  left.correlationId === right.correlationId &&
  left.audience === right.audience &&
  left.traceId === right.traceId;

const ownerSnapshot = Effect.fn('AddressAction.ownerSnapshot')(function* snapshotAddressOwner(
  transaction: ScopedTransactionExecutor,
  scope: OperationalScope,
  payload: Payload,
  savedAddressId: string | undefined,
) {
  if (scope.legalEntityId === undefined) {
    return yield* unavailable();
  }
  const [profiles, addresses] = yield* Effect.all(
    [
      readAddressProfileSnapshot(transaction, payload.profile.profileRef.resourceId, payload.profile.kind),
      addressPreparationSnapshot(transaction, scope, payload, savedAddressId),
    ],
    { concurrency: 1 },
  ).pipe(Effect.mapError(unavailable));
  return { addresses, profiles };
});

export const prepareAddressPartyServices = Effect.fn('AddressAction.prepareServices')(
  function* prepareAddressPartyServicesEffect(payload: Payload, context: ActionServicePreparationContext) {
    const scope = { ...context.scope };
    const selector = structuredClone(payload);
    const update = Schema.is(UpdateSavedAddressPayloadSchema)(selector) ? selector : undefined;
    const add = update === undefined && Schema.is(AddSavedAddressPayloadSchema)(selector) ? selector : undefined;
    const savedAddressId = update?.savedAddressRef.resourceId;
    const matches = (candidate: Payload) =>
      update === undefined
        ? add !== undefined && Schema.is(AddSavedAddressPayloadSchema)(candidate) && sameAdd(add, candidate)
        : Schema.is(UpdateSavedAddressPayloadSchema)(candidate) && sameUpdate(update, candidate);
    const isParty = selector.origin?.kind === 'PARTY_BACKED';
    const before = isParty
      ? yield* context.transaction((transaction) => ownerSnapshot(transaction, scope, selector, savedAddressId))
      : null;
    // Party is read for the Action's own verified actor (the original scope object carries its provenance), once,
    // before any SQL, under the same module operation requirement the persistence validator uses.
    const crypto = yield* Crypto.Crypto;
    const requirementKey: PartyAddressRequirementKey =
      update === undefined
        ? 'commerce.customer-context.requirement.add-saved-address-party'
        : 'commerce.customer-context.requirement.update-saved-address-party';
    const evidence = isParty
      ? yield* preparePartyAddressSource(
          selector,
          scope.correlationId,
          partyContactPointExecutorForScope(context.scope, crypto, requirementKey),
        )
      : null;
    const validatePartySource = (candidate: Payload) =>
      matches(candidate) && evidence !== null
        ? assertPreparedPartyAddressCurrent(evidence)
        : Effect.fail(unavailableSource());
    const factory: ActionServiceFactory<ReturnType<typeof addressActionPersistenceForTransaction>> = Effect.fn(
      'AddressAction.bindPreparedServices',
    )(function* bindPreparedAddressServices(transaction, verifiedScope, revision) {
      if (!sameScope(scope, verifiedScope) || revision !== context.compositionRevision) {
        return yield* unavailable();
      }
      if (before !== null) {
        const current = yield* ownerSnapshot(transaction, verifiedScope, selector, savedAddressId);
        if (!sameSnapshot(before, current)) {
          return yield* unavailable();
        }
      }
      const services = addressActionPersistenceForTransaction(transaction, verifiedScope, validatePartySource);
      return {
        ...services,
        add: (candidate: AddSavedAddressPayload, attribution: Parameters<typeof services.add>[1]) =>
          matches(candidate) &&
          attribution.actionInvocationId === context.actionInvocationId &&
          attribution.principalId === scope.principalId
            ? services.add(candidate, attribution)
            : Effect.fail(unavailableSource()),
        update: (candidate: UpdateSavedAddressPayload, attribution: Parameters<typeof services.update>[1]) =>
          matches(candidate) &&
          attribution.actionInvocationId === context.actionInvocationId &&
          attribution.principalId === scope.principalId
            ? services.update(candidate, attribution)
            : Effect.fail(unavailableSource()),
      };
    });
    return factory;
  },
);
