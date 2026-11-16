import { sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { CoreDatabase } from '../db/client.ts';
import type { ManagedApiKeyScope } from './managed-api-key-scope.ts';
import { validateManagedApiKeyTarget } from './managed-api-key-scope.ts';
import { IdentityPersistenceUnavailableError } from './principal-management-errors.ts';
import type { IdentityTargetInvalidError } from './principal-management-errors.ts';

const eligibilityUnavailable = () =>
  new IdentityPersistenceUnavailableError({
    code: 'identity_persistence_unavailable',
    reason: 'Managed API key eligibility is unavailable',
  });

/** The key a person asks the Shell to issue for another principal, before any provider key exists. */
export interface ManagedApiKeyTargetRequest {
  readonly legalEntityId: string | undefined;
  readonly principalId: string;
  readonly scope: ManagedApiKeyScope;
  readonly tenantId: string;
}

/**
 * Eligibility before issuance: the same target check the bind Action runs (a platform principal, a principal bound to
 * a platform-registered workload, the wrong kind or scope are refused), run before the provider issues anything, so a
 * refused target never gets a key that then has to be disabled. It is not authorization: the bind Action still checks
 * the caller's rights and the target again in its own transaction.
 */
export class ManagedApiKeyTargetEligibility extends Context.Service<
  ManagedApiKeyTargetEligibility,
  {
    readonly check: (
      request: ManagedApiKeyTargetRequest,
    ) => Effect.Effect<void, IdentityPersistenceUnavailableError | IdentityTargetInvalidError>;
  }
>()('@app/core-runtime/auth/managed-api-key-eligibility/ManagedApiKeyTargetEligibility') {}

export const ManagedApiKeyTargetEligibilityLive = Layer.effect(
  ManagedApiKeyTargetEligibility,
  Effect.gen(function* prepareManagedApiKeyTargetEligibility() {
    const { executor } = yield* CoreDatabase;
    return {
      check: Effect.fn('ManagedApiKeyTargetEligibility.check')(function* check(request: ManagedApiKeyTargetRequest) {
        return yield* executor
          .transaction((transaction) =>
            transaction.execute(sql`select set_config('ontos.tenant_id', ${request.tenantId}, true)`).pipe(
              Effect.andThen(
                validateManagedApiKeyTarget(transaction, {
                  issuing: true,
                  legalEntityId: request.legalEntityId,
                  principalId: request.principalId,
                  requireActive: true,
                  scope: request.scope,
                  tenantId: request.tenantId,
                }),
              ),
            ),
          )
          .pipe(
            Effect.catchTags({
              EffectDrizzleQueryError: () => Effect.fail(eligibilityUnavailable()),
              SqlError: () => Effect.fail(eligibilityUnavailable()),
            }),
          );
      }),
    };
  }),
);
