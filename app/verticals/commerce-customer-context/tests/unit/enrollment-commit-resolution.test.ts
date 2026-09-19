import { Effect, Layer, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionAlreadyCommitted, ActionInvocationStateError, ActionRuntime } from '@app/core-runtime';
import type { ActionRuntimeService, ResolveActionCommitInput } from '@app/core-runtime';
import { ReadPrincipalBindingResultSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import type {
  ExternalIdentityClientPort,
  ReadPrincipalBindingResult,
} from '@app/shared-contracts/server/external-identity-client';

import {
  CommerceEnrollmentCommitResolutionRevoked,
  CommerceEnrollmentCommitResolutionUnavailable,
} from '../../src/enrollment/commit-resolution/commit-resolution-errors.ts';
import {
  CommerceEnrollmentCommitResolutionService,
  CommerceEnrollmentCommitResolutionServiceLive,
  makeCommerceEnrollmentCommitResolutionService,
} from '../../src/enrollment/commit-resolution/commit-resolution-service.ts';
import {
  EnrollmentCommitResolutionCommittedSchema,
  EnrollmentCommitResolutionConvergedSchema,
  EnrollmentCommitResolutionOutcomeSchema,
  EnrollmentCommitResolutionPartialFailureSchema,
  EnrollmentRetainedCorePairSchema,
} from '../../src/enrollment/commit-resolution/commit-resolution-contracts.ts';
import type { EnrollmentCommitResolutionInput } from '../../src/enrollment/commit-resolution/commit-resolution-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentActionInvocationIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';

const tenantId = Schema.decodeSync(EnrollmentTenantIdSchema)('10000000-0000-4000-8000-000000000001');
const invocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('30000000-0000-4000-8000-000000000001');
const otherInvocationId = Schema.decodeSync(EnrollmentActionInvocationIdSchema)('30000000-0000-4000-8000-000000000002');
const principal = { subject: 'test-principal' } as const;

const accountSubject = Schema.decodeSync(CommercePortalAccountSubjectSchema)({
  authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
  providerSubjectId: 'commit-resolution-provider-subject',
  subjectType: 'user' as const,
});

const clientOptions = () => ({
  apiKey: Redacted.make('test'),
  baseUrl: 'https://core.invalid',
  requestCorrelation: 'commit-resolution-unit',
});

const unusedClient: ExternalIdentityClientPort = {
  activatePrincipalBinding: () => Effect.die('unused'),
  changePrincipalBindingStatus: () => Effect.die('unused'),
  issueExternalGatewayContext: () => Effect.die('unused'),
  readPrincipalBinding: () => Effect.die('unused'),
  reservePrincipalBinding: () => Effect.die('unused'),
  resolveExternalSubject: () => Effect.die('unused'),
};

const foundBinding = (overrides: {
  readonly bindingStatus: 'active' | 'disabled' | 'pending' | 'revoked';
  readonly originalInvocationId: typeof invocationId | null;
}): ReadPrincipalBindingResult =>
  Schema.decodeSync(ReadPrincipalBindingResultSchema)({
    authBindingId: '80000000-0000-4000-8000-000000000001',
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    bindingRevision: 3,
    bindingStatus: overrides.bindingStatus,
    originalInvocationId: overrides.originalInvocationId,
    outcome: 'FOUND' as const,
    principalId: '90000000-0000-4000-8000-000000000001',
    principalStatus: 'active' as const,
    tenantStatus: 'active' as const,
  });

const input = (overrides: Partial<EnrollmentCommitResolutionInput> = {}): EnrollmentCommitResolutionInput => ({
  originalInvocationId: invocationId,
  principal,
  tenantId,
  ...overrides,
});

const runtimeDouble = (resolveActionCommit: ActionRuntimeService['resolveActionCommit']): ActionRuntimeService => ({
  resolveActionCommit,
  runAction: () => Effect.die('unused'),
});

it.effect(
  'resolves a committed-but-lost ack as Committed with no Core read requested, through the published Context.Service tag and Layer',
  () =>
    Effect.gen(function* committedLostAck() {
      const testLayer = Layer.merge(
        Layer.succeed(
          ActionRuntime,
          runtimeDouble((_resolveInput: ResolveActionCommitInput) =>
            Effect.fail(
              new ActionAlreadyCommitted({
                code: 'action_already_committed',
                invocationId,
                reason: 'This idempotency key already committed successfully',
              }),
            ),
          ),
        ),
        Layer.succeed(ExternalIdentityClient, unusedClient),
      );
      const outcome = yield* Effect.gen(function* runResolve() {
        const service = yield* CommerceEnrollmentCommitResolutionService;
        return yield* service.resolve(input());
      }).pipe(Effect.provide(Layer.provide(CommerceEnrollmentCommitResolutionServiceLive, testLayer)));
      expect(Schema.is(EnrollmentCommitResolutionCommittedSchema)(outcome)).toBe(true);
      expect(Schema.is(EnrollmentCommitResolutionOutcomeSchema)(outcome)).toBe(true);
      expect(outcome.invocationId).toBe(invocationId);
      expect('retainedBinding' in outcome ? outcome.retainedBinding : undefined).toBeUndefined();
    }),
);

it.effect('resolves an uncertain write that actually succeeded, converging on the governed Core read', () =>
  Effect.gen(function* uncertainWriteThenSuccess() {
    const runtime = {
      resolveActionCommit: (_resolveInput: ResolveActionCommitInput) =>
        Effect.fail(
          new ActionAlreadyCommitted({
            code: 'action_already_committed',
            invocationId,
            reason: 'This idempotency key already committed successfully',
          }),
        ),
    };
    const client: ExternalIdentityClientPort = {
      ...unusedClient,
      readPrincipalBinding: () =>
        Effect.succeed(foundBinding({ bindingStatus: 'active', originalInvocationId: invocationId })),
    };
    const service = makeCommerceEnrollmentCommitResolutionService(runtime, client);
    const outcome = yield* service.resolve(input({ identityRead: { accountSubject, clientOptions: clientOptions() } }));
    expect(Schema.is(EnrollmentCommitResolutionCommittedSchema)(outcome)).toBe(true);
    expect(outcome.invocationId).toBe(invocationId);
    const retainedBinding = 'retainedBinding' in outcome ? outcome.retainedBinding : undefined;
    expect(Schema.is(EnrollmentRetainedCorePairSchema)(retainedBinding)).toBe(true);
    expect(retainedBinding?.principalId).toBe('90000000-0000-4000-8000-000000000001');
  }),
);

it.effect('resolves an uncertain write that actually failed, recording the real partial Core state', () =>
  Effect.gen(function* uncertainWriteThenFailure() {
    const runtime = {
      resolveActionCommit: (_resolveInput: ResolveActionCommitInput) =>
        Effect.fail(
          new ActionInvocationStateError({
            code: 'action_invocation_state_invalid',
            reason: 'This Action invocation has a terminal non-committed state',
          }),
        ),
    };
    const client: ExternalIdentityClientPort = {
      ...unusedClient,
      readPrincipalBinding: () =>
        Effect.succeed(foundBinding({ bindingStatus: 'active', originalInvocationId: invocationId })),
    };
    const service = makeCommerceEnrollmentCommitResolutionService(runtime, client);
    const outcome = yield* service.resolve(input({ identityRead: { accountSubject, clientOptions: clientOptions() } }));
    expect(Schema.is(EnrollmentCommitResolutionPartialFailureSchema)(outcome)).toBe(true);
    expect(outcome.invocationId).toBe(invocationId);
    expect('retainedBinding' in outcome ? outcome.retainedBinding?.authBindingId : undefined).toBe(
      '80000000-0000-4000-8000-000000000001',
    );
  }),
);

it.effect('converges two attempts against the same subject onto the single retained Core pair', () =>
  Effect.gen(function* twoAttemptsConverge() {
    const runtime = {
      resolveActionCommit: (_resolveInput: ResolveActionCommitInput) =>
        Effect.fail(
          new ActionAlreadyCommitted({
            code: 'action_already_committed',
            invocationId,
            reason: 'This idempotency key already committed successfully',
          }),
        ),
    };
    const client: ExternalIdentityClientPort = {
      ...unusedClient,
      readPrincipalBinding: () =>
        Effect.succeed(foundBinding({ bindingStatus: 'active', originalInvocationId: otherInvocationId })),
    };
    const service = makeCommerceEnrollmentCommitResolutionService(runtime, client);
    const outcome = yield* service.resolve(input({ identityRead: { accountSubject, clientOptions: clientOptions() } }));
    expect(Schema.is(EnrollmentCommitResolutionConvergedSchema)(outcome)).toBe(true);
    expect(outcome.invocationId).toBe(invocationId);
    expect('convergedInvocationId' in outcome ? outcome.convergedInvocationId : undefined).toBe(otherInvocationId);
  }),
);

it.effect('fails closed (T20) when a historical commit read finds the current retained binding revoked', () =>
  Effect.gen(function* historicalCommitRevoked() {
    const runtime = {
      resolveActionCommit: (_resolveInput: ResolveActionCommitInput) =>
        Effect.fail(
          new ActionAlreadyCommitted({
            code: 'action_already_committed',
            invocationId,
            reason: 'This idempotency key already committed successfully',
          }),
        ),
    };
    const client: ExternalIdentityClientPort = {
      ...unusedClient,
      readPrincipalBinding: () =>
        Effect.succeed(foundBinding({ bindingStatus: 'revoked', originalInvocationId: invocationId })),
    };
    const service = makeCommerceEnrollmentCommitResolutionService(runtime, client);
    const error = yield* service
      .resolve(input({ identityRead: { accountSubject, clientOptions: clientOptions() } }))
      .pipe(Effect.flip);
    expect(error).toBeInstanceOf(CommerceEnrollmentCommitResolutionRevoked);
    expect(Schema.is(CommerceEnrollmentCommitResolutionRevoked)(error) ? error.bindingStatus : undefined).toBe(
      'revoked',
    );
    expect(error).not.toBeInstanceOf(CommerceEnrollmentCommitResolutionUnavailable);
  }),
);

it.effect(
  'reports the caller\'s invocationId (not the retained binding\'s originalInvocationId) when a non-current binding converges onto a different attempt',
  () =>
    Effect.gen(function* nonCurrentConvergenceReportsCallerInvocation() {
      const runtime = {
        resolveActionCommit: (_resolveInput: ResolveActionCommitInput) =>
          Effect.fail(
            new ActionAlreadyCommitted({
              code: 'action_already_committed',
              invocationId,
              reason: 'This idempotency key already committed successfully',
            }),
          ),
      };
      const client: ExternalIdentityClientPort = {
        ...unusedClient,
        readPrincipalBinding: () =>
          Effect.succeed(foundBinding({ bindingStatus: 'revoked', originalInvocationId: otherInvocationId })),
      };
      const service = makeCommerceEnrollmentCommitResolutionService(runtime, client);
      const error = yield* service
        .resolve(input({ identityRead: { accountSubject, clientOptions: clientOptions() } }))
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(CommerceEnrollmentCommitResolutionRevoked);
      expect(Schema.is(CommerceEnrollmentCommitResolutionRevoked)(error) ? error.invocationId : undefined).toBe(
        invocationId,
      );
      expect(Schema.is(CommerceEnrollmentCommitResolutionRevoked)(error) ? error.bindingStatus : undefined).toBe(
        'revoked',
      );
    }),
);
