import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect } from 'effect';

import type {
  AddPartyOfficialIdentifierResult,
  AddPartyOfficialIdentifierResultSchema,
} from '../../shared/actions/add-party-official-identifier.ts';
import { createAddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxMessage } from './add-party-official-identifier.party-registry-official-identifier-added-v1.outbox-message.ts';
import type { MatchingOfficialIdentifierUpdate } from '../services/party-official-identifier-persistence.service.ts';
import type { OfficialIdentifierUpdatedEventSchema } from './update-party-official-identifier.action.ts';
import { createUpdatePartyOfficialIdentifierPartyRegistryOfficialIdentifierUpdatedV1OutboxMessage } from './update-party-official-identifier.party-registry-official-identifier-updated-v1.outbox-message.ts';
// eslint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Pure ResourceRef value constructor.
import { makePartyOfficialIdentifierRef } from '../services/party-official-identifier-reference.ts';

export const publishAttachedOfficialIdentifiers = (
  context: Pick<
    ActionHandlerContext<{
      readonly 'party.registry.official-identifier-added.v1': typeof AddPartyOfficialIdentifierResultSchema;
    }>,
    'addDomainEvent' | 'addOutboxMessage'
  >,
  partyRef: AddPartyOfficialIdentifierResult['partyRef'],
  identifiers: readonly AddPartyOfficialIdentifierResult['officialIdentifierRef'][],
) =>
  Effect.forEach(
    identifiers,
    Effect.fn(function* publishIdentifier(officialIdentifierRef) {
      const payload = { officialIdentifierRef, partyRef };
      const event = yield* context.addDomainEvent({
        eventType: 'party.registry.official-identifier-added.v1',
        payloadJson: payload,
        producerModuleKey: 'party.registry',
        subjectModuleKey: 'party.registry',
        subjectResourceId: officialIdentifierRef.resourceId,
        subjectResourceType: officialIdentifierRef.resourceType,
      });
      yield* context.addOutboxMessage(
        event,
        createAddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxMessage(payload),
      );
    }),
    { concurrency: 1, discard: true },
  );

export const publishUpdatedOfficialIdentifiers = (
  context: Pick<
    ActionHandlerContext<{
      readonly 'party.registry.official-identifier-updated.v1': typeof OfficialIdentifierUpdatedEventSchema;
    }>,
    'addDomainEvent' | 'addOutboxMessage'
  >,
  partyRef: AddPartyOfficialIdentifierResult['partyRef'],
  identifiers: readonly MatchingOfficialIdentifierUpdate[],
  evidenceRefs: readonly string[],
  reason: string,
) =>
  Effect.forEach(
    identifiers,
    Effect.fn(function* publishIdentifier(update) {
      const payload: typeof OfficialIdentifierUpdatedEventSchema.Type = {
        after: update.after,
        before: update.before,
        changeType: 'SET_VERIFICATION' as const,
        evidenceRefs: update.evidenceRefs ?? evidenceRefs,
        officialIdentifierRef: makePartyOfficialIdentifierRef(partyRef.tenantId, update.officialIdentifierId),
        partyRef,
        reason,
      };
      const event = yield* context.addDomainEvent({
        eventType: 'party.registry.official-identifier-updated.v1',
        payloadJson: payload,
        producerModuleKey: 'party.registry',
        subjectModuleKey: 'party.registry',
        subjectResourceId: update.officialIdentifierId,
        subjectResourceType: 'party.registry.official-identifier',
      });
      yield* context.addOutboxMessage(
        event,
        createUpdatePartyOfficialIdentifierPartyRegistryOfficialIdentifierUpdatedV1OutboxMessage({
          officialIdentifierRef: payload.officialIdentifierRef,
          partyRef,
        }),
      );
    }),
    { concurrency: 1, discard: true },
  );
