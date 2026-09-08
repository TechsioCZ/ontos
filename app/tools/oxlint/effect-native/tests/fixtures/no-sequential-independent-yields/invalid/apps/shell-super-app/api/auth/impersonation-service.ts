// expect-count: 1
// B1 preserves deterministic ordering: reconcileAuthUser performs writes, not enrichment reads.
// Module-local generator helpers (`Identifier` callees) are the repo's most common independent-read
// shape: two recovery loads on the same headers, and two account reconciliations.
import { Effect } from 'effect';

declare const loadExpiredImpersonationRecovery: (headers: Headers) => Effect.Effect<string>;
declare const recoverOriginalSession: (headers: Headers) => Effect.Effect<string>;
declare const reconcileAuthUser: (config: string, account: string) => Effect.Effect<{ readonly userId: string }>;

export const stopImpersonation = (headers: Headers) =>
  Effect.gen(function* stopImpersonationEffect() {
    const expiredRecovery = yield* loadExpiredImpersonationRecovery(headers);
    const recovered = yield* recoverOriginalSession(headers);
    return { expiredRecovery, recovered };
  });

export const bootstrap = (configuration: string, accounts: readonly string[]) =>
  Effect.gen(function* bootstrapStageDemoEffect() {
    const techsioAuthUser = yield* reconcileAuthUser(configuration, accounts[0] ?? '');
    const siamparkAuthUser = yield* reconcileAuthUser(configuration, accounts[1] ?? '');
    return { siamparkAuthUser, techsioAuthUser };
  });
