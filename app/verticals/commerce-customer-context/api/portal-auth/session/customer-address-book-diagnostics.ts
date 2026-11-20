import type { ReadCoreError } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';

const ReadPhaseSchema = Schema.Literals(['saved_address_list', 'saved_address_defaults']);
type ReadPhase = typeof ReadPhaseSchema.Type;
const BoundaryPhaseSchema = Schema.Literals(['provider_session', 'workload_principal', 'customer_authority']);
type BoundaryPhase = typeof BoundaryPhaseSchema.Type;
const BoundaryFailureSchema = Schema.Literals([
  'session_absent',
  'provider_session_rejected',
  'workload_authentication_failed',
  'workload_unavailable',
  'customer_authority_rejected',
  'customer_authority_unavailable',
]);
type BoundaryFailure = typeof BoundaryFailureSchema.Type;

/** Only exact, source-owned reasons become diagnostics; an arbitrary reason is never logged. */
const authenticationReasons = new Map([
  ['The authenticated principal binding is unavailable', 'binding_missing'],
  ['The authenticated principal context reference is unavailable', 'context_ref_missing'],
  ['The authentication namespace is not registered', 'namespace_unregistered'],
  ['The receiving audience is not registered for this namespace', 'audience_unregistered'],
  ['The authentication subject type is not registered for this namespace', 'subject_type_unregistered'],
  ['The receiving audience is required for external admission', 'audience_missing'],
  ['The authenticated principal binding is no longer valid', 'binding_not_current'],
  ['The authenticated principal subject type is not valid', 'binding_subject_mismatch'],
  ['The authentication admission does not match current Core identity', 'admission_mismatch'],
  ['The system principal context is not trusted', 'system_context_untrusted'],
]);

export const logCustomerAddressBookReadFailure = (phase: ReadPhase) => (error: ReadCoreError) =>
  Effect.logWarning('Commerce customer address-book request refused').pipe(
    Effect.annotateLogs({
      addressBookPhase: phase,
      authenticationReason: Match.value(error).pipe(
        Match.tag('OperationAuthenticationRequired', (failure) => authenticationReasons.get(failure.reason) ?? 'other'),
        Match.orElse(() => 'not_applicable'),
      ),
      failureTag: error._tag,
    }),
  );

export const logCustomerAddressBookBoundaryFailure = (phase: BoundaryPhase, failure: BoundaryFailure) =>
  Effect.logWarning('Commerce customer address-book request refused').pipe(
    Effect.annotateLogs({ addressBookPhase: phase, failureTag: failure }),
  );
