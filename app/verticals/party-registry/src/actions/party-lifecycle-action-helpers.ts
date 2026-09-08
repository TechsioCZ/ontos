import { createHash } from 'node:crypto';

import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';

import {
  partyIdFromString,
  PartyLifecycleConflict,
  PartyNotFound,
  PartyPersistenceUnavailable,
  PartySchema,
} from '../../shared/domain/identity-contracts.ts';
import type { PartyLifecycle } from '../services/party-identity-persistence.service.ts';

type PersistedParty = typeof PartySchema.Type | typeof PartySchema.Encoded;
export const decodeParty = (party: PersistedParty) =>
  Schema.is(PartySchema)(party)
    ? Effect.succeed(party)
    : Schema.decodeUnknownEffect(PartySchema)(party).pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new PartyPersistenceUnavailable({
              code: 'party_persistence_unavailable',
              reason: 'The stored Party could not be decoded',
            }),
            'cause',
            { configurable: true, value: cause }
          )
        )
      );

export const resolvePartyLifecycle = (
  persistenceResult: PartyLifecycle,
  resourceId: string,
  conflict: ConstructorParameters<typeof PartyLifecycleConflict>[0]
) =>
  Match.value(persistenceResult).pipe(
    Match.tag('not_found', () =>
      Effect.fail(
        new PartyNotFound({
          code: 'party_not_found',
          partyId: partyIdFromString(resourceId),
          reason: 'The Party does not exist',
        })
      )
    ),
    Match.tag('conflict', () =>
      Effect.fail(new PartyLifecycleConflict(conflict))
    ),
    Match.tag('found', ({ value }) => decodeParty(value)),
    Match.exhaustive
  );

export const recordPartyInvariantAccess = (
  context: Pick<
    ActionHandlerContext<Readonly<Record<string, never>>>,
    'recordDataAccess'
  >,
  party: typeof PartySchema.Type,
  queryPrefix: string
) =>
  context.recordDataAccess({
    accessKind: 'read',
    queryHash: createHash('sha256')
      .update(`${queryPrefix}:${party.partyRef.resourceId}`)
      .digest('hex'),
    resultCount: 1,
    servingModuleKey: 'party.registry',
    targetModuleKey: 'party.registry',
    targetResourceId: party.partyRef.resourceId,
    targetResourceType: party.partyRef.resourceType,
  });
