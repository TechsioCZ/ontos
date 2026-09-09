import { createHash } from 'node:crypto';

import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect } from 'effect';

import type { ConfirmDuplicatePartiesPayload } from '../../shared/actions/confirm-duplicate-parties.ts';
import type { transitionDuplicateCandidateCase } from '../services/party-matching-persistence.service.ts';

interface Services {
  readonly resolve: (
    payload: ConfirmDuplicatePartiesPayload,
    invocationId: string,
  ) => ReturnType<typeof transitionDuplicateCandidateCase>;
}
export const handleDuplicateCaseResolution = (
  payload: ConfirmDuplicatePartiesPayload,
  context: ActionHandlerContext<Readonly<Record<string, never>>, Services>,
) =>
  context.services.resolve(payload, context.actionInvocationId).pipe(
    Effect.tap((result) =>
      context.recordDataAccess({
        accessKind: 'read',
        queryHash: createHash('sha256').update(`duplicate-case-invariants:${payload.caseRef.resourceId}`).digest('hex'),
        resultCount: 1,
        servingModuleKey: 'party.registry',
        targetModuleKey: 'party.registry',
        targetResourceId: result.caseRef.resourceId,
        targetResourceType: result.caseRef.resourceType,
      }),
    ),
  );
