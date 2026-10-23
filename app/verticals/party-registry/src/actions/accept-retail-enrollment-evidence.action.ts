import type { ActionHandlerContext } from '@app/core-runtime';
import { ActionRuntime, defineAction, defineTenantModuleEntrypoint } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import {
  AcceptRetailEnrollmentEvidencePayloadSchema,
  AcceptRetailEnrollmentEvidenceResultSchema,
} from '../../shared/actions/accept-retail-enrollment-evidence.ts';
import { PartyEvidenceInsufficient, PartyPersistenceUnavailable } from '../../shared/domain/identity-contracts.ts';
import { ClaimOwnedByDifferentParty, DuplicateCandidateConflict } from '../../shared/domain/matching-contracts.ts';
import { PartyRefSchema } from '../../shared/resources/party.ts';
import { acceptRetailEnrollmentEvidence } from '../services/party-matching-persistence.service.ts';
import { createCreatePartyPartyRegistryPartyCreatedV1OutboxMessage } from './create-party.party-registry-party-created-v1.outbox-message.ts';

const domainEvents = { 'party.registry.party-created.v1': Schema.Struct({ partyRef: PartyRefSchema }) } as const;
export interface AcceptRetailEnrollmentServices {
  readonly accept: (
    payload: typeof AcceptRetailEnrollmentEvidencePayloadSchema.Type,
    invocationId: string,
  ) => ReturnType<typeof acceptRetailEnrollmentEvidence>;
}

/** An explicit workload attestation grant, not identity-review authority. */
export const acceptRetailEnrollmentEvidenceAction = defineAction(
  {
    accessEvidencePolicy: {
      captureMode: 'metadata_only',
      policyKey: 'party.registry.retail-enrollment-evidence.access.v1',
    },
    actionKey: 'party.registry.accept-retail-enrollment-evidence',
    auditProfile: 'standard',
    domainErrorSchema: Schema.Union([
      ClaimOwnedByDifferentParty,
      DuplicateCandidateConflict,
      PartyEvidenceInsufficient,
      PartyPersistenceUnavailable,
    ]),
    domainEvents,
    entrypoint: defineTenantModuleEntrypoint({
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'explicit' },
      entrypointKey: 'party.registry.accept-retail-enrollment-evidence',
      moduleKey: 'party.registry',
      role: 'action',
    }),
    idempotency: 'required',
    legalEntityScope: 'required',
    owningModuleKey: 'party.registry',
    payloadSchema: AcceptRetailEnrollmentEvidencePayloadSchema,
    policies: [],
    resultSchema: AcceptRetailEnrollmentEvidenceResultSchema,
    schemaVersion: '1',
    tenantPermission: () => 'manage_party_identity',
  },
  Effect.fn('AcceptRetailEnrollmentEvidenceAction.handle')(function* accept(
    payload: typeof AcceptRetailEnrollmentEvidencePayloadSchema.Type,
    context: ActionHandlerContext<typeof domainEvents, AcceptRetailEnrollmentServices>,
  ) {
    const { created, result } = yield* context.services.accept(payload, context.actionInvocationId);
    const target = result.outcome === 'AMBIGUOUS' ? result.caseRef : result.partyRef;
    yield* context.recordDataAccess({
      accessKind: 'read',
      queryHash: payload.originalInvocationId,
      resultCount: 1,
      servingModuleKey: 'party.registry',
      targetModuleKey: 'party.registry',
      targetResourceId: target.resourceId,
      targetResourceType: target.resourceType,
    });
    if (created && result.outcome === 'CREATED') {
      const event = yield* context.addDomainEvent({
        eventType: 'party.registry.party-created.v1',
        payloadJson: { partyRef: result.partyRef },
        producerModuleKey: 'party.registry',
        subjectModuleKey: 'party.registry',
        subjectResourceId: result.partyRef.resourceId,
        subjectResourceType: result.partyRef.resourceType,
      });
      yield* context.addOutboxMessage(
        event,
        createCreatePartyPartyRegistryPartyCreatedV1OutboxMessage({ partyRef: result.partyRef }),
      );
    }
    return result;
  }),
  Effect.fn('AcceptRetailEnrollmentEvidenceAction.makeServices')(function* makeServices(transaction, scope) {
    const runtime = yield* ActionRuntime;
    return {
      accept: Effect.fn('AcceptRetailEnrollmentEvidenceAction.acceptOwned')(function* acceptOwned(
        payload: typeof AcceptRetailEnrollmentEvidencePayloadSchema.Type,
        actionInvocationId: string,
      ) {
        // resolveActionCommit enforces exact tenant, company and original caller ownership.
        // No caller-supplied Party/case identifier can substitute for that native lookup.
        const committed = yield* runtime
          .resolveActionCommit({ invocationId: payload.originalInvocationId, principal: scope })
          .pipe(
            Effect.as(false),
            Effect.catchTag('ActionAlreadyCommitted', () => Effect.succeed(true)),
            Effect.mapError((cause) =>
              Object.assign(
                new PartyEvidenceInsufficient({
                  code: 'party_evidence_insufficient',
                  reason: 'The original Create is not committed and owned by this workload',
                }),
                { cause },
              ),
            ),
          );
        if (
          !committed ||
          scope.legalEntityId === undefined ||
          payload.evidence.tenantId !== scope.tenantId ||
          payload.evidence.sellingLegalEntityId !== scope.legalEntityId
        ) {
          return yield* new PartyEvidenceInsufficient({
            code: 'party_evidence_insufficient',
            reason: 'Retail evidence does not match the trusted invocation scope',
          });
        }
        return yield* acceptRetailEnrollmentEvidence(transaction, {
          ...payload,
          actionInvocationId,
          legalEntityId: scope.legalEntityId,
          principalId: scope.principalId,
          tenantId: scope.tenantId,
        });
      }),
    };
  }),
);
