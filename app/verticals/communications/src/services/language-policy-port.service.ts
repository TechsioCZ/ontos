import { Context } from 'effect';
import type { Crypto, DateTime, Effect, Option } from 'effect';
import type { LanguageMode } from '../../shared/language-policy.ts';
import type { LanguagePolicyStoreUnavailable as LanguagePolicyStoreUnavailableClass } from '../../shared/language-policy-errors.ts';

type LanguagePolicyStoreUnavailable = InstanceType<typeof LanguagePolicyStoreUnavailableClass>;

/** One immutable version of a Tenant's own language mode choice. */
export interface LanguageModeVersionRecord {
  readonly mode: LanguageMode;
  readonly policyVersionId: string;
  readonly setAt: DateTime.Utc;
  readonly setByPrincipalId: string;
  readonly versionNumber: number;
}

/**
 * The owner-local port to the Tenant language mode history, generated as this owner's Action service and Read service.
 * Every program takes it as an argument: the scoped transaction exists only per invocation, and the Tenant is the one
 * the Core scope installed, never a value a caller can name.
 */
export interface LanguagePolicyPortContract {
  /** Appends the next version; the number is assigned under the Tenant lock, so numbers never collide. */
  readonly append: (input: {
    readonly actionInvocationId: string;
    readonly mode: LanguageMode;
    readonly principalId: string;
  }) => Effect.Effect<LanguageModeVersionRecord, LanguagePolicyStoreUnavailable, Crypto.Crypto>;
  /** The Tenant's latest own choice; none is a proven absence of an own choice, not an unreadable setting. */
  readonly latest: Effect.Effect<Option.Option<LanguageModeVersionRecord>, LanguagePolicyStoreUnavailable>;
  /** Serializes the writers of this Tenant's mode for the rest of the transaction. */
  readonly lockTenant: Effect.Effect<void, LanguagePolicyStoreUnavailable>;
}

export class LanguagePolicyPort extends Context.Service<LanguagePolicyPort, LanguagePolicyPortContract>()(
  '@app/communications/services/language-policy-port.service/LanguagePolicyPort',
) {}
