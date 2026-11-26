import { Effect, Option } from 'effect';
import {
  LanguagePolicyVersionIdSchema,
  PLATFORM_DEFAULT_LANGUAGE_MODE,
  PLATFORM_DEFAULT_LANGUAGE_POLICY_VERSION,
} from '../../shared/language-policy.ts';
import type { EffectiveLanguagePolicy, LanguageMode } from '../../shared/language-policy.ts';
import type { LanguagePolicySnapshot } from '../domain/language/vocabulary.ts';
import type { LanguageModeVersionRecord, LanguagePolicyPortContract } from './language-policy-port.service.ts';
import { clampBusinessTime } from './template-revision-domain.service.ts';

const effectiveOf = (latest: Option.Option<LanguageModeVersionRecord>): EffectiveLanguagePolicy =>
  Option.match(latest, {
    // Only a proven absence of an own choice means the platform default; an unreadable setting never reaches this.
    onNone: () => ({
      mode: PLATFORM_DEFAULT_LANGUAGE_MODE,
      policy: { platformDefaultVersion: PLATFORM_DEFAULT_LANGUAGE_POLICY_VERSION, source: 'platform-default' },
    }),
    onSome: (version) => ({
      mode: version.mode,
      policy: {
        policyVersionId: LanguagePolicyVersionIdSchema.make(version.policyVersionId),
        source: 'tenant',
        versionNumber: version.versionNumber,
      },
    }),
  });

/** The effective mode of the Tenant of the port: its own latest choice, or the platform default when it has none. */
export const effectiveLanguagePolicy = Effect.fn('LanguagePolicy.effective')(function* effective(
  port: LanguagePolicyPortContract,
) {
  return effectiveOf(yield* port.latest);
});

/**
 * The language mode as a decision needs it: effective, or unreadable. A store failure is a fact the decision records and
 * stops on (fail closed); it is never replaced by the platform default.
 */
export const readLanguagePolicySnapshot = (port: LanguagePolicyPortContract): Effect.Effect<LanguagePolicySnapshot> =>
  effectiveLanguagePolicy(port).pipe(
    Effect.map((effective): LanguagePolicySnapshot => ({ kind: 'effective', ...effective })),
    Effect.orElseSucceed((): LanguagePolicySnapshot => ({ kind: 'unreadable' })),
  );

export interface LanguagePolicyActor {
  readonly actionInvocationId: string;
  readonly principalId: string;
}

/**
 * Sets the mode of the Tenant of the port. Only the Tenant's own mode can be reached, because the port is bound to the
 * trusted Tenant. A choice equal to the Tenant's own latest one appends nothing; a decision made earlier is never touched
 * either way, because decisions pin the version they used.
 */
export const setLanguageMode = Effect.fn('LanguagePolicy.set')(function* setMode(
  port: LanguagePolicyPortContract,
  mode: LanguageMode,
  actor: LanguagePolicyActor,
) {
  yield* port.lockTenant;
  const latest = yield* port.latest;
  if (Option.isSome(latest) && latest.value.mode === mode) {
    return { changed: false, effective: effectiveOf(latest) };
  }
  // Business time is taken only now, under the Tenant lock, and never earlier than the version it follows: a writer that
  // began first but took the lock last still gets a later time than the version it succeeds.
  const floor = latest.pipe(Option.map((version) => version.setAt));
  const setAt = clampBusinessTime(yield* port.clockNow, floor);
  const appended = yield* port.append({
    actionInvocationId: actor.actionInvocationId,
    mode,
    principalId: actor.principalId,
    setAt,
  });
  return { changed: true, effective: effectiveOf(Option.some(appended)) };
});
