import { Context, Effect, Layer, Option, Schema } from 'effect';

import { ActionRuntime } from '@app/core-runtime';
import type { ActionCommitIndeterminate, ActionRuntimeService } from '@app/core-runtime';
import { ReadPrincipalBindingPayloadSchema } from '@app/core-runtime/auth/external-identity-contracts';
import type { AuthBindingStatusSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { ExternalIdentityClient } from '@app/shared-contracts/server/external-identity-client';
import type {
  ExternalIdentityClientPort,
  ReadPrincipalBindingResult,
} from '@app/shared-contracts/server/external-identity-client';

import { withCause } from '../attempts/errors.ts';
import {
  CommerceEnrollmentCommitResolutionRejected,
  CommerceEnrollmentCommitResolutionRevoked,
  CommerceEnrollmentCommitResolutionUnavailable,
} from './commit-resolution-errors.ts';
import type { CommerceEnrollmentCommitResolutionError } from './commit-resolution-errors.ts';
import type {
  EnrollmentCommitResolutionIdentityRead,
  EnrollmentCommitResolutionInput,
  EnrollmentCommitResolutionOutcome,
  EnrollmentRetainedCorePair,
} from './commit-resolution-contracts.ts';

const unavailable = (
  invocationId: EnrollmentCommitResolutionInput['originalInvocationId'],
  code: string,
  reason: string,
  cause?: unknown,
): InstanceType<typeof CommerceEnrollmentCommitResolutionUnavailable> => {
  const error = new CommerceEnrollmentCommitResolutionUnavailable({
    code: code.slice(0, 200),
    invocationId,
    reason: reason.slice(0, 500),
    retryable: true,
  });
  return cause === undefined ? error : withCause(error, cause);
};

const rejected = (
  invocationId: EnrollmentCommitResolutionInput['originalInvocationId'],
  code: string,
  reason: string,
  retryable: boolean,
): InstanceType<typeof CommerceEnrollmentCommitResolutionRejected> =>
  new CommerceEnrollmentCommitResolutionRejected({
    code: code.slice(0, 200),
    invocationId,
    reason: reason.slice(0, 500),
    retryable,
  });

/** A Core-runtime tag that can only ever mean a definitive refusal of the original invocation. */
const rejectWith =
  (invocationId: EnrollmentCommitResolutionInput['originalInvocationId'], code: string, reason: string) =>
  (): Effect.Effect<never, CommerceEnrollmentCommitResolutionError> =>
    Effect.fail(rejected(invocationId, code, reason, false));

const revoked = (
  invocationId: EnrollmentCommitResolutionInput['originalInvocationId'],
  bindingStatus: NonCurrentBindingStatus,
): InstanceType<typeof CommerceEnrollmentCommitResolutionRevoked> =>
  new CommerceEnrollmentCommitResolutionRevoked({
    bindingStatus,
    code: 'commit_resolution_binding_revoked',
    invocationId,
    reason: 'The retained Core binding for this original invocation is no longer current',
    retryable: false,
  });

const open = (
  invocationId: EnrollmentCommitResolutionInput['originalInvocationId'],
): EnrollmentCommitResolutionOutcome => ({
  _tag: 'EnrollmentCommitResolutionOpen',
  invocationId,
});

const committed = (
  invocationId: EnrollmentCommitResolutionInput['originalInvocationId'],
  retainedBinding?: EnrollmentRetainedCorePair,
): EnrollmentCommitResolutionOutcome =>
  retainedBinding === undefined
    ? { _tag: 'EnrollmentCommitResolutionCommitted', invocationId }
    : { _tag: 'EnrollmentCommitResolutionCommitted', invocationId, retainedBinding };

const converged = (
  invocationId: EnrollmentCommitResolutionInput['originalInvocationId'],
  convergedInvocationId: EnrollmentCommitResolutionInput['originalInvocationId'],
  retainedBinding: EnrollmentRetainedCorePair,
): EnrollmentCommitResolutionOutcome => ({
  _tag: 'EnrollmentCommitResolutionConverged',
  convergedInvocationId,
  invocationId,
  retainedBinding,
});

const partialFailure = (
  invocationId: EnrollmentCommitResolutionInput['originalInvocationId'],
  retainedBinding?: EnrollmentRetainedCorePair,
): EnrollmentCommitResolutionOutcome =>
  retainedBinding === undefined
    ? { _tag: 'EnrollmentCommitResolutionPartialFailure', invocationId }
    : { _tag: 'EnrollmentCommitResolutionPartialFailure', invocationId, retainedBinding };

type BindingStatus = typeof AuthBindingStatusSchema.Type;

const CurrentBindingStatusSchema = Schema.Literals(['active', 'pending']);
const isCurrentBindingStatus = Schema.is(CurrentBindingStatusSchema);

const NonCurrentBindingStatusSchema = Schema.Literals(['disabled', 'revoked']);
type NonCurrentBindingStatus = typeof NonCurrentBindingStatusSchema.Type;

export interface CommerceEnrollmentCommitResolutionServicePort {
  readonly resolve: (
    input: EnrollmentCommitResolutionInput,
  ) => Effect.Effect<EnrollmentCommitResolutionOutcome, CommerceEnrollmentCommitResolutionError>;
}

/**
 * Converges Commerce enrollment Action writes after `ActionAlreadyCommitted` or an uncertain
 * write outcome.  Resolution is read-only: it never re-dispatches a write, so a historical
 * success can never be replayed as a new effect.  It always resolves using the ORIGINAL
 * invocation identity, never a newly minted one.
 *
 * Takes its Core collaborators as two explicit positional parameters (not a bundled options
 * bag) so directly-testable construction stays plain data-flow: callers, including unit tests
 * supplying doubles, pass the exact seams they hold rather than assembling an intermediate
 * record type.
 */
export const makeCommerceEnrollmentCommitResolutionService = (
  runtime: Pick<ActionRuntimeService, 'resolveActionCommit'>,
  client: ExternalIdentityClientPort,
): CommerceEnrollmentCommitResolutionServicePort => {
  const readRetainedBinding = Effect.fn('CommerceEnrollmentCommitResolutionService.readRetainedBinding')(
    function* readRetainedBindingEffect(
      invocationId: EnrollmentCommitResolutionInput['originalInvocationId'],
      identityRead: EnrollmentCommitResolutionIdentityRead,
    ): Effect.fn.Return<ReadPrincipalBindingResult, CommerceEnrollmentCommitResolutionError> {
      const payload = yield* Schema.decodeEffect(ReadPrincipalBindingPayloadSchema)({
        authenticationNamespaceId: identityRead.accountSubject.authenticationNamespaceId,
        lookup: 'subject' as const,
        providerSubjectId: identityRead.accountSubject.providerSubjectId,
        subjectType: identityRead.accountSubject.subjectType,
      }).pipe(
        Effect.mapError((cause) =>
          unavailable(
            invocationId,
            'commit_resolution_subject_invalid',
            'The account subject could not be encoded for the Core read',
            cause,
          ),
        ),
      );
      return yield* client
        .readPrincipalBinding(payload, identityRead.clientOptions)
        .pipe(
          Effect.mapError((cause) =>
            unavailable(
              invocationId,
              'commit_resolution_core_read_failed',
              'The governed Core principal binding read failed',
              cause,
            ),
          ),
        );
    },
  );

  /**
   * Interprets a governed Core read against the Action truth already established
   * (`actionOutcome`).  Any binding bound to a different, current original invocation is a
   * genuine convergence signal, not a conflict: the exact-subject storage invariant in Core
   * guarantees there is only ever one retained pair, so the caller must absorb it.
   */
  const interpretIdentityRead = Effect.fn('CommerceEnrollmentCommitResolutionService.interpretIdentityRead')(
    function* interpretIdentityReadEffect(
      invocationId: EnrollmentCommitResolutionInput['originalInvocationId'],
      actionOutcome: 'committed' | 'failed',
      identityRead: EnrollmentCommitResolutionIdentityRead,
    ): Effect.fn.Return<EnrollmentCommitResolutionOutcome, CommerceEnrollmentCommitResolutionError> {
      const result = yield* readRetainedBinding(invocationId, identityRead);
      if (result.outcome === 'NOT_FOUND') {
        return actionOutcome === 'committed' ? committed(invocationId) : partialFailure(invocationId);
      }
      const retainedBinding: EnrollmentRetainedCorePair = {
        authBindingId: result.authBindingId,
        bindingRevision: result.bindingRevision,
        principalId: result.principalId,
      };
      const bindingStatus: BindingStatus = result.bindingStatus;
      const boundToUs =
        Option.isSome(result.originalInvocationId) && result.originalInvocationId.value === invocationId;
      if (boundToUs) {
        if (isCurrentBindingStatus(bindingStatus)) {
          return actionOutcome === 'committed'
            ? committed(invocationId, retainedBinding)
            : partialFailure(invocationId, retainedBinding);
        }
        return yield* revoked(invocationId, bindingStatus);
      }
      if (Option.isNone(result.originalInvocationId)) {
        return yield* rejected(
          invocationId,
          'commit_resolution_provenance_missing',
          'The retained Core binding for this subject has no recorded provenance to converge against',
          false,
        );
      }
      if (!isCurrentBindingStatus(bindingStatus)) {
        return yield* revoked(invocationId, bindingStatus);
      }
      return converged(invocationId, result.originalInvocationId.value, retainedBinding);
    },
  );

  const resolve = Effect.fn('CommerceEnrollmentCommitResolutionService.resolve')(function* resolveEffect(
    input: EnrollmentCommitResolutionInput,
  ): Effect.fn.Return<EnrollmentCommitResolutionOutcome, CommerceEnrollmentCommitResolutionError> {
    const { identityRead, originalInvocationId } = input;
    const onAlreadyCommitted = () =>
      identityRead === undefined
        ? Effect.succeed(committed(originalInvocationId))
        : interpretIdentityRead(originalInvocationId, 'committed', identityRead);
    const onCommitIndeterminate = (failure: ActionCommitIndeterminate) =>
      Effect.fail(
        unavailable(
          originalInvocationId,
          'commit_resolution_indeterminate',
          'The Action runtime could not determine whether the original invocation committed',
          failure,
        ),
      );
    const onInvocationStateError = () =>
      identityRead === undefined
        ? Effect.succeed(partialFailure(originalInvocationId))
        : interpretIdentityRead(originalInvocationId, 'failed', identityRead);
    return yield* runtime.resolveActionCommit({ invocationId: originalInvocationId, principal: input.principal }).pipe(
      Effect.map(() => open(originalInvocationId)),
      Effect.catchTags({
        ActionAlreadyCommitted: onAlreadyCommitted,
        ActionCommitIndeterminate: onCommitIndeterminate,
        ActionInvocationNotFound: rejectWith(
          originalInvocationId,
          'commit_resolution_invocation_not_found',
          'The original invocation is unknown to the Action runtime',
        ),
        ActionInvocationStateError: onInvocationStateError,
        ActionPayloadValidationError: rejectWith(
          originalInvocationId,
          'commit_resolution_payload_invalid',
          'The original invocation payload failed validation',
        ),
        ActionTrustedContextValidationError: rejectWith(
          originalInvocationId,
          'commit_resolution_context_invalid',
          'The trusted context supplied for resolution failed validation',
        ),
      }),
    );
  });

  return Object.freeze({ resolve });
};

/** Context seam for enrollment journeys/driver; requirements are left open for composition. */
export class CommerceEnrollmentCommitResolutionService extends Context.Service<
  CommerceEnrollmentCommitResolutionService,
  CommerceEnrollmentCommitResolutionServicePort
>()(
  '@app/commerce-customer-context/enrollment/commit-resolution/commit-resolution-service/CommerceEnrollmentCommitResolutionService',
) {}

export const CommerceEnrollmentCommitResolutionServiceLive = Layer.effect(
  CommerceEnrollmentCommitResolutionService,
  Effect.gen(function* makeLive() {
    const runtime = yield* ActionRuntime;
    const client = yield* ExternalIdentityClient;
    return makeCommerceEnrollmentCommitResolutionService(runtime, client);
  }),
);

/**
 * Convergence is only meaningful against the Core identity transport that holds the retained pair,
 * so a deployment that named no transport refuses retryably instead of reporting an uncertain write
 * as settled. The refusal is retryable because the missing input is a deployment configuration, not
 * a decision about the invocation.
 */
export const commerceEnrollmentCommitResolutionUnavailableLive = Layer.succeed(
  CommerceEnrollmentCommitResolutionService,
  {
    resolve: (input) =>
      Effect.fail(
        new CommerceEnrollmentCommitResolutionUnavailable({
          code: 'commit_resolution_transport_unavailable',
          invocationId: input.originalInvocationId,
          reason: 'The Commerce Core identity transport is not installed in this deployment',
          retryable: true,
        }),
      ),
  },
);
