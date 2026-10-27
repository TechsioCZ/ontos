import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect } from 'effect';
import { Hex } from 'effect/encoding';

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
        queryHash: Hex.encode(sha256(utf8ToBytes(`duplicate-case-invariants:${payload.caseRef.resourceId}`))),
        resultCount: 1,
        servingModuleKey: 'party.registry',
        targetModuleKey: 'party.registry',
        targetResourceId: result.caseRef.resourceId,
        targetResourceType: result.caseRef.resourceType,
      }),
    ),
  );
