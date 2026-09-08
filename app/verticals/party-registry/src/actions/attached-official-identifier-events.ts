import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect } from 'effect';
import type {
  AddPartyOfficialIdentifierResult,
  AddPartyOfficialIdentifierResultSchema,
} from '../../shared/actions/add-party-official-identifier.ts';
import { createAddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxMessage } from './add-party-official-identifier.party-registry-official-identifier-added-v1.outbox-message.ts';

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
        createAddPartyOfficialIdentifierPartyRegistryOfficialIdentifierAddedV1OutboxMessage(
          payload,
        ),
      );
    }),
    { concurrency: 1, discard: true },
  );
