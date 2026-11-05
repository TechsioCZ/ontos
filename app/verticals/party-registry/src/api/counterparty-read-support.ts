import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Match } from 'effect';

import type { CounterpartyPersistenceUnavailable } from '../../shared/domain/counterparty-errors.ts';
import type { CounterpartyRef } from '../../shared/party-registry-references.ts';
import type { LookupResult } from '../services/counterparty-persistence.service.ts';

const notFound = (context: string) =>
  new ReadHandlerNotFound({
    code: 'read_handler_not_found',
    reason: `The Counterparty does not exist in the ${context}`,
  });

export const resolveCounterpartyRead = <Value>(
  ref: CounterpartyRef,
  tenantId: string,
  load: (counterpartyId: string) => Effect.Effect<LookupResult<Value>, CounterpartyPersistenceUnavailable>,
  unavailableReason: string,
) =>
  ref.tenantId === tenantId
    ? load(ref.resourceId).pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: unavailableReason,
            }),
            'cause',
            { value: cause },
          ),
        ),
        Effect.flatMap((result) =>
          Match.value(result).pipe(
            Match.tag('found', ({ value }) => Effect.succeed(value)),
            Match.tag('not_found', () => Effect.fail(notFound('authorized context'))),
            Match.exhaustive,
          ),
        ),
      )
    : Effect.fail(notFound('trusted Tenant'));
