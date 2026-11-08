import { crmClientEvidenceReference } from '../../shared/domain/crm-client-evidence.ts';
import { ActionAlreadyCommitted, ActionCommitIndeterminate, ActionRuntime } from '@app/core-runtime';
import { NodeCrypto } from '@effect/platform-node';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { DateTime, Effect } from 'effect';
import type { ActionRuntimeService, ResolveActionCommitInput } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import { crmClientIntakeReviewRead } from '../../src/api/crm-client-intake-review.read.ts';
import { partyRegistryRegistration } from '../../vertical.registration.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const invocationId = '40000000-0000-4000-8000-000000000001';
const principal = {
  tenantId,
  legalEntityId,
  principalId: '30000000-0000-4000-8000-000000000087',
  authMethod: 'api_key' as const,
  authBindingId: '40000000-0000-4000-8000-000000000087',
  authContextRef: 'api-key:crm-intake',
  correlationId: 'crm-intake-review',
};
const caseRef = {
  moduleId: 'party.registry' as const,
  resourceType: 'party.registry.duplicate-candidate-case' as const,
  resourceId: '60000000-0000-4000-8000-000000000001',
  tenantId,
};
const decisionRef = {
  moduleId: 'party.registry' as const,
  resourceType: 'party.registry.party-match-decision' as const,
  resourceId: '60000000-0000-4000-8000-000000000002',
  tenantId,
};
const input = { clientId: 'client-1', caseRef, decisionRef, sourceScope: { tenantId, legalEntityId } };

it.layer(NodeCrypto.layer)('CRM intake owner review', (suite) => {
  for (const [evidenceKind, expected] of [
    ['weak', 'create'],
    ['official', 'review'],
    ['missing', 'review'],
  ] as const) {
    suite.effect(
      `native owner purpose Read returns only ${expected} for owned ${evidenceKind} evidence, never sensitive fields`,
      () =>
        Effect.gen(function* ownedReview() {
          let attested = true;
          const harness = yield* makeReadTestHarness({
            access: 'allowed',
            ownerAuthorizationDecision: 'allowed',
            ownerRegistration: partyRegistryRegistration,
            scope: principal,
            operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-11-07T00:00:00Z')),
            executeOwnerQuery: ({ sql, params, scope }) => {
              expect(scope).toEqual({ tenantId, legalEntityId });
              if (sql.includes('party_match_decisions')) {
                expect(params).toContain(decisionRef.resourceId);
                expect(params).toContain(caseRef.resourceId);
                expect(params).toContain('CREATE');
                return Effect.succeed([{ invocationId }]);
              }
              if (sql.includes('duplicate_candidate_case_parties')) {
                return Effect.succeed([]);
              }
              if (sql.includes('duplicate_candidate_cases')) {
                return Effect.succeed([
                  {
                    candidateCaseId: caseRef.resourceId,
                    tenantId,
                    candidateFingerprint: 'a'.repeat(64),
                    evaluationFingerprint: 'b'.repeat(64),
                    priorCandidateCaseId: null,
                    candidateSnapshot: {
                      businessName: 'Private customer name',
                      partyType: 'ORGANIZATION',
                      evidenceArtifactRefs: [crmClientEvidenceReference({ tenantId, legalEntityId }, 'client-1')],
                      subjectEvidence: attested
                        ? [
                            {
                              kind: 'ACTOR_ATTESTATION',
                              subjectKey: crmClientEvidenceReference({ tenantId, legalEntityId }, 'client-1'),
                              evidenceRef: crmClientEvidenceReference({ tenantId, legalEntityId }, 'client-1'),
                              basis: 'DIRECT_INTERACTION',
                              observedSubject: 'ORGANIZATION',
                              statement: 'Private owner proof',
                            },
                          ]
                        : [],
                      provenance: { method: 'MANUAL_ENTRY', source: 'demo.crm.client-intake' },
                      validFrom: '2026-11-01T00:00:00Z',
                    },
                    evaluatedEvidence:
                      evidenceKind === 'missing'
                        ? []
                        : [
                            evidenceKind === 'official'
                              ? { identifierType: 'ICO', reason: 'Private matching evidence' }
                              : { reason: 'Private matching evidence' },
                          ],
                    matchRuleVersion: 'rule',
                    lifecycleState: 'OPEN',
                    revision: 3,
                    assignedPrincipalId: null,
                    resolutionOutcome: null,
                    selectedPartyId: null,
                    resolutionActionInvocationId: null,
                    resolutionReason: null,
                    resolvedAt: null,
                    createdAt: '2026-11-01T00:00:00Z',
                    updatedAt: '2026-11-01T00:00:00Z',
                  },
                ]);
              }
              return Effect.die(`Unexpected owner SQL: ${sql}`);
            },
          });
          let proofs = 0;
          let committed = true;
          const runtime = {
            runAction: () => Effect.die('Review Read must not execute a business Action'),
            resolveActionExecution: () => Effect.die('Review Read must not reserve another execution'),
            resolveActionCommit: (request: ResolveActionCommitInput) =>
              Effect.suspend((): ReturnType<ActionRuntimeService['resolveActionCommit']> => {
                proofs += 1;
                expect(request.invocationId).toBe(invocationId);
                expect(request.principal).toMatchObject({
                  principalId: principal.principalId,
                  tenantId,
                  legalEntityId,
                });
                if (!committed) {
                  return Effect.fail(
                    new ActionCommitIndeterminate({
                      code: 'action_commit_indeterminate',
                      invocationId,
                      reason: 'Original native Create has no verified commit',
                    }),
                  );
                }
                return Effect.fail(
                  new ActionAlreadyCommitted({
                    code: 'action_already_committed',
                    invocationId,
                    reason: 'Owned native Create committed',
                  }),
                );
              }),
          };
          const run = (payload: typeof input) =>
            harness.runtime
              .runRead({
                principal,
                input: payload,
                registration: crmClientIntakeReviewRead,
                transport: { correlationId: principal.correlationId },
              })
              .pipe(Effect.provideService(ActionRuntime, runtime));
          const result = yield* run(input);
          expect(result).toEqual({ outcome: expected, revision: 3 });
          expect(Object.keys(result).toSorted()).toEqual(['outcome', 'revision']);
          expect(proofs).toBe(1);
          const foreign = yield* run({
            ...input,
            sourceScope: { tenantId, legalEntityId: '20000000-0000-4000-8000-000000000099' },
          }).pipe(Effect.flip);
          expect(foreign._tag).toBe('ReadHandlerNotFound');
          expect(proofs).toBe(1);
          const unrelated = yield* run({ ...input, clientId: 'unrelated-client' }).pipe(Effect.flip);
          expect(unrelated._tag).toBe('ReadHandlerNotFound');
          attested = false;
          const unattested = yield* run(input).pipe(Effect.flip);
          expect(unattested._tag).toBe('ReadHandlerNotFound');
          attested = true;
          committed = false;
          const uncommitted = yield* run(input).pipe(Effect.flip);
          expect(uncommitted._tag).toBe('ReadHandlerUnavailable');
        }),
    );
  }
});
