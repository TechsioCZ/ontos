import { trustVerifiedGatewayPrincipalContext, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { CoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { Crypto, Effect, Schema } from 'effect';

import {
  BindPreVerificationSubjectPayloadSchema,
  BindPreVerificationSubjectResultSchema,
  WithdrawPreVerificationBindingPayloadSchema,
  WithdrawPreVerificationBindingResultSchema,
} from '../../shared/actions/pre-verification-binding-operations.ts';
import {
  PreVerificationEligibilityRequestSchema,
  PreVerificationEligibilityResponseSchema,
} from '../../shared/apis/pre-verification-eligibility.ts';
import { PreVerificationBindingPolicySchema } from '../../shared/domain/pre-verification-binding.ts';
import { preVerificationBindingRepositoryFor } from '../../src/persistence/pre-verification-binding-repository.ts';
import {
  bindPreVerificationSubject,
  evaluatePreVerificationEligibilityRequest,
  withdrawPreVerificationBinding,
} from '../../src/services/pre-verification-binding.service.ts';
import { inPrivacyLedger } from './privacy-ledger-scope.ts';

export { privacyLedgerDatabaseLive as preVerificationPrivacyDatabaseLive } from './privacy-ledger-scope.ts';

/**
 * TEST-ONLY seam of the Privacy pre-verification binding contract (#1406 D.8). It runs the REAL owner bodies (exactly the
 * functions the two Actions and the governed Read run after authorization) over Privacy's REAL table in native
 * PostgreSQL as the runtime role, inside Core's own operational-scope installer, so row-level security applies.
 *
 * Every call crosses the published schemas both ways, as the HTTP transport would: the request is decoded with the
 * owner's payload schema and the answer is encoded with its result schema. The caller is the verified calling module of
 * the call, as the Shell would sign it. What this seam does NOT run: the HTTP gateway, the access gate and its SpiceDB
 * authorization engine, and the Action runtime's idempotency ledger; those are different seams.
 *
 * Policies are the caller's own, and in tests they are clearly FICTIONAL: Privacy has no approved policy for any purpose.
 */
/** The Tenant, the optional Legal Entity and the verified module a call comes from. */
export interface PreVerificationCall {
  readonly callerAppId: string;
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const COMPOSITION_REVISION = 'e'.repeat(64);

const scopeOf = Effect.fn('PrivacyPreVerificationNative.scope')(function* scope(call: PreVerificationCall) {
  const crypto = yield* Crypto.Crypto;
  const tenantWide = {
    authBindingId: yield* crypto.randomUUIDv4(),
    authContextRef: `fixture:pre-verification:${call.callerAppId}`,
    authenticationNamespaceId: 'core.staff',
    authMethod: 'session',
    principalId: call.principalId,
    tenantId: call.tenantId,
  };
  const principal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(
    call.legalEntityId === undefined ? tenantWide : { ...tenantWide, legalEntityId: call.legalEntityId },
  ).pipe(Effect.orDie);
  return trustVerifiedGatewayPrincipalContext(
    { ...principal, correlationId: `fixture:pre-verification:${call.tenantId}` },
    COMPOSITION_REVISION,
    undefined,
    { appId: call.callerAppId, buildMarker: `${call.callerAppId}-build`, principalId: call.principalId },
  );
});

/** The owner seam over a fixed set of (FICTIONAL) policies, in the published encoded form. */
export const makePreVerificationPrivacyNative = Effect.fn('PrivacyPreVerificationNative.make')(function* make(
  policies: readonly (typeof PreVerificationBindingPolicySchema.Encoded)[],
) {
  const decodedPolicies = yield* Schema.decodeUnknownEffect(Schema.Array(PreVerificationBindingPolicySchema))(policies);
  const crypto = yield* Crypto.Crypto;
  const database = yield* CoreDatabase;
  /** Every call runs on the database and crypto the seam was built with, so a consumer transport needs nothing more. */
  const owned = <Value, Failure>(program: Effect.Effect<Value, Failure, CoreDatabase | Crypto.Crypto>) =>
    program.pipe(Effect.provideService(CoreDatabase, database), Effect.provideService(Crypto.Crypto, crypto));
  return {
    /** The bind Action body: the encoded payload in, the encoded result out, or its typed rejection. */
    bind: (call: PreVerificationCall, payload: typeof BindPreVerificationSubjectPayloadSchema.Encoded) =>
      owned(
        Effect.gen(function* bind() {
          const decoded = yield* Schema.decodeUnknownEffect(BindPreVerificationSubjectPayloadSchema)(payload);
          const scope = yield* scopeOf(call);
          const result = yield* inPrivacyLedger(scope, (transaction) =>
            bindPreVerificationSubject(decoded, scope, {
              newBindingRef: crypto.randomUUIDv4().pipe(Effect.orDie),
              policies: decodedPolicies,
              repository: preVerificationBindingRepositoryFor(transaction, scope),
            }),
          );
          return yield* Schema.encodeEffect(BindPreVerificationSubjectResultSchema)(result);
        }),
      ),
    /** The governed Read body: the encoded request in, the encoded published answer out. */
    eligibility: (call: PreVerificationCall, request: typeof PreVerificationEligibilityRequestSchema.Encoded) =>
      owned(
        Effect.gen(function* eligibility() {
          const decoded = yield* Schema.decodeUnknownEffect(PreVerificationEligibilityRequestSchema)(request);
          const scope = yield* scopeOf(call);
          const response = yield* inPrivacyLedger(scope, (transaction) =>
            evaluatePreVerificationEligibilityRequest(decoded, scope, {
              policies: decodedPolicies,
              repository: preVerificationBindingRepositoryFor(transaction, scope),
            }),
          );
          return yield* Schema.encodeEffect(PreVerificationEligibilityResponseSchema)(response);
        }),
      ),
    /** The withdraw Action body, as the acting Privacy principal of the call. */
    withdraw: (call: PreVerificationCall, payload: typeof WithdrawPreVerificationBindingPayloadSchema.Encoded) =>
      owned(
        Effect.gen(function* withdraw() {
          const decoded = yield* Schema.decodeUnknownEffect(WithdrawPreVerificationBindingPayloadSchema)(payload);
          const scope = yield* scopeOf(call);
          const result = yield* inPrivacyLedger(scope, (transaction) =>
            withdrawPreVerificationBinding(decoded, scope, preVerificationBindingRepositoryFor(transaction, scope)),
          );
          return yield* Schema.encodeEffect(WithdrawPreVerificationBindingResultSchema)(result);
        }),
      ),
  };
});

export type PreVerificationPrivacyNative = Effect.Success<ReturnType<typeof makePreVerificationPrivacyNative>>;
