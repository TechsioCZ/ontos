import { ReadHandlerUnavailable, defineRead, defineTenantModuleEntrypoint } from '@app/core-runtime';
import type { ReadHandlerContext } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import { ActionInvocationIdSchema } from '../../shared/domain/correction-contracts.ts';
import { PartyCreateOutcomeSchema } from '../../shared/domain/identity-contracts.ts';
import { withPartyClientSourcePrivacyRequirement } from '../services/party-client-source-privacy.service.ts';
import { findPartyCreateContinuation } from '../services/party-matching-persistence.service.ts';

export interface PartyCommandResultServices {
  readonly find: (invocationId: string) => ReturnType<typeof findPartyCreateContinuation>;
}

/** Private recovery projection: the HTTP caller must first pass native invocation ownership. */
export const partyCommandResultRead = defineRead(
  {
    accessDeclaration: {
      key: 'party.registry.owned-command-result.read',
      kind: 'read',
      modes: ['run'],
      placement: { group: 'party-identity', level: 'basic' },
      risk: 'sensitive',
      selectors: [],
    },
    accessKind: 'detail',
    entrypoint: defineTenantModuleEntrypoint({
      access: 'read',
      authorization: { kind: 'protected' },
      entrypointKey: 'party.registry.api.owned-command-result',
      moduleKey: 'party.registry',
      role: 'api',
    }),
    evidencePolicy: { captureMode: 'metadata_only', policyKey: 'party.registry.api.owned-command-result.evidence.v1' },
    inputSchema: Schema.Struct({ invocationId: ActionInvocationIdSchema }),
    legalEntityScope: 'optional',
    owningModuleKey: 'party.registry',
    policies: [],
    readKey: 'party.registry.api.owned-command-result',
    resultSchema: Schema.Struct({ createResult: Schema.optionalKey(PartyCreateOutcomeSchema) }),
    schemaVersion: '1',
  },
  (input, context: ReadHandlerContext<PartyCommandResultServices>) =>
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
  (transaction, scope) =>
    Effect.succeed({
      // A source-created result recovers only through its exact source receipt and current source Privacy.
      find: (invocationId: string) =>
        findPartyCreateContinuation(transaction, scope.tenantId, invocationId, scope).pipe(
          withPartyClientSourcePrivacyRequirement('party.registry.api.owned-command-result'),
        ),
    }),
);
