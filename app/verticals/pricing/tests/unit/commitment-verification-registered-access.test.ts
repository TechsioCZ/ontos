import {
  defineOntosModuleManifest,
  defineVerticalRuntimeRegistration,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
} from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime';
import {
  makeModuleContractFixture,
  makeOwnerApplicationCompositionFixture,
} from '@app/core-runtime/testing/module-contract';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer, Match } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { CommitmentConfirmationVerificationApi } from '../../shared/apis/commitment-confirmation-verification.ts';
import { commitmentConfirmationVerificationRead } from '../../src/api/commitment-confirmation-verification.read.ts';
import { pricingCommitmentConfirmationVerificationFactoryLive } from '../../src/services/commitment-confirmation-verification.service.ts';
import { makeIssue788Binding, makeIssue788CommercialTotal } from './support/issue-788-confirmation.fixture.ts';

const base = makeModuleContractFixture({
  appId: 'pricing-verification-access-test',
  moduleId: 'commerce.pricing',
}).manifest;
// Test publication retains the original private Read, including its actor declaration and remote finish.
const ownerRegistration = defineVerticalRuntimeRegistration({
  actions: [],
  manifest: defineOntosModuleManifest({
    ...base,
    publicSurface: {
      ...base.publicSurface,
      api: { 'commitment-confirmation-verification': CommitmentConfirmationVerificationApi },
      components: {},
    },
  }),
  outboxWorkers: [],
  reads: [commitmentConfirmationVerificationRead],
});
const scope: OperationalScope = {
  authBindingId: '78800000-0000-4000-8000-000000000001',
  authContextRef: 'session:pricing-verification-registered-access',
  authMethod: 'session',
  correlationId: 'pricing-verification-registered-access',
  legalEntityId: '78800000-0000-4000-8000-000000000002',
  principalId: '78800000-0000-4000-8000-000000000003',
  tenantId: '78800000-0000-4000-8000-000000000004',
};
const confirmationRef = 'pricing-commitment-confirmation:registered-access';

it.layer(Layer.mergeAll(NodeCrypto.layer, TestClock.layer(), pricingCommitmentConfirmationVerificationFactoryLive))(
  'original Commitment verification Read admission',
  (suite) => {
    for (const access of ['allowed', 'denied', 'unavailable'] as const) {
      suite.effect(`${access} retains the original admission, recovery factory and fail-closed remote phase`, () =>
        Effect.scoped(
          Effect.gen(function* originalVerificationLifecycle() {
            const composition = yield* makeOwnerApplicationCompositionFixture({
              appId: 'pricing-verification-access-test',
              ownerRegistration,
            });
            const harness = yield* makeReadTestHarness({
              access,
              applicationComposition: composition.applicationComposition,
              compositionRevision: composition.snapshot.composition.revision,
              executeOwnerQuery: (query) => {
                expect(access).toBe('allowed');
                expect(query.sql).toContain('"pricing"."read_pricing_commitment_confirmation_v1"');
                expect(query.params).toEqual([scope.tenantId, scope.legalEntityId, confirmationRef]);
                expect(query.scope).toEqual({ legalEntityId: scope.legalEntityId, tenantId: scope.tenantId });
                return Effect.succeed([{ payload: { confirmationRef, outcome: 'ABSENT' } }]);
              },
              expectedDeployment: composition.expectedDeployment,
              operationTime: DateTime.toDateUtc(yield* DateTime.now),
              ownerAuthorizationDecision: 'allowed',
              ownerRegistration,
              scope,
            });
            const requestedBinding = makeIssue788Binding(yield* makeIssue788CommercialTotal());
            const failure = yield* harness.runtime
              .runRead({
                input: { confirmationRef, requestedBinding },
                principal: scope,
                registration: commitmentConfirmationVerificationRead,
                transport: { correlationId: scope.correlationId },
              })
              .pipe(Effect.flip);
            const expectedFailure = Match.value(access).pipe(
              Match.when('allowed', () => ReadHandlerUnavailable),
              Match.when('denied', () => ReadPermissionDenied),
              Match.when('unavailable', () => ReadPermissionUnavailable),
              Match.exhaustive,
            );
            expect(failure).toBeInstanceOf(expectedFailure);
            expect(harness.snapshot().ownerQueries).toHaveLength(access === 'allowed' ? 1 : 0);
            expect(harness.snapshot().stages).not.toContain('handler_executed');
          }),
        ),
      );
    }
    suite('preserves the exact original confirmation-verification actor and native declaration', () => {
      expect(commitmentConfirmationVerificationRead.descriptor.accessActor).toMatchObject({
        callers: ['commerce-order'],
        subject: 'identity',
      });
      expect(commitmentConfirmationVerificationRead.descriptor.accessDeclaration).toMatchObject({
        key: 'commerce.pricing.commitment-confirmation.verify',
        kind: 'read',
        modes: ['run'],
        placement: { group: 'commercial-commitments', level: 'extended' },
        risk: 'sensitive',
        selectors: [],
      });
      expect(commitmentConfirmationVerificationRead.descriptor.permissionTarget).toBeUndefined();
    });
  },
);
