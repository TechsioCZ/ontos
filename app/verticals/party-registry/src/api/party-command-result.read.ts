import type { ReadLoadContext } from '@app/core-runtime';
import { ReadHandlerUnavailable, defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import { ActionInvocationIdSchema } from '../../shared/domain/correction-contracts.ts';
import { PartyCreateOutcomeSchema } from '../../shared/domain/identity-contracts.ts';
import { findPartyCreateContinuation } from '../services/party-matching-persistence.service.ts';

export interface PartyCommandResultServices {
  readonly find: (invocationId: string) => ReturnType<typeof findPartyCreateContinuation>;
}

/** Private recovery projection: the HTTP caller must first pass native invocation ownership. */
export const partyCommandResultRead = defineRead(
  {
    accessKind: 'detail',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'context_permission', permission: 'module.access' },
      entrypointKey: 'party.registry.api.owned-command-result',
      moduleKey: 'party.registry',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'party.registry.api.owned-command-result.evidence.v1' },
    inputSchema: Schema.Struct({ invocationId: ActionInvocationIdSchema }),
    legalEntityScope: 'optional',
    owningModuleKey: 'party.registry',
    permissionTarget: 'tenant',
    policies: [],
    readKey: 'party.registry.api.owned-command-result',
    resultSchema: Schema.Struct({ createResult: Schema.optionalKey(PartyCreateOutcomeSchema) }),
    schemaVersion: '1',
  },
  {
    load: (input, context: ReadLoadContext<PartyCommandResultServices>) =>
      context.services.find(input.invocationId).pipe(
        Effect.mapError((cause) =>
          Object.assign(
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: 'The owned Party command result is unavailable',
            }),
            { cause },
          ),
        ),
        Effect.map((createResult) => ({
          evidence: { resultCount: createResult === undefined ? 0 : 1 },
          result: createResult === undefined ? {} : { createResult },
        })),
      ),
  },
  (transaction, scope) =>
    Effect.succeed({
      find: (invocationId: string) => findPartyCreateContinuation(transaction, scope.tenantId, invocationId),
    }),
  () => ({ kind: 'tenant', permission: 'manage_party_identity' }),
);
