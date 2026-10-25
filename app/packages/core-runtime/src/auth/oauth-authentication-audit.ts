import { sql } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';

import { CoreDatabase } from '../db/client.ts';
import { auditEvents } from '../db/schema.ts';
import { oauthAuthenticationAuditRow } from './oauth-authentication-audit-contract.ts';
import type { OAuthAuthenticationObservation } from './oauth-authentication-audit-contract.ts';
import { OAuthAuthenticationAuditUnavailable } from './oauth-authentication-audit-unavailable.ts';

export class OAuthAuthenticationAudit extends Context.Service<
  OAuthAuthenticationAudit,
  {
    readonly record: (
      observation: OAuthAuthenticationObservation,
    ) => Effect.Effect<void, OAuthAuthenticationAuditUnavailable>;
  }
>()('@app/core-runtime/auth/OAuthAuthenticationAudit') {}

/**
 * Native authentication observer, like PrincipalResolver's pre-admission denial writer. It does not run an Action
 * or require an active binding: refresh reuse must remain observable after the very binding has been disabled.
 * Only Core's real database producer is captured here; neither an executor nor a schema crosses the owner boundary.
 */
export const OAuthAuthenticationAuditLive = Layer.effect(
  OAuthAuthenticationAudit,
  Effect.gen(function* oauthAuthenticationAuditService() {
    const { executor } = yield* CoreDatabase;
    return {
      record: Effect.fn('OAuthAuthenticationAudit.record')(
        function* record(observation: OAuthAuthenticationObservation) {
          const row = yield* oauthAuthenticationAuditRow(observation);
          yield* executor.transaction(
            Effect.fn('OAuthAuthenticationAudit.transaction')(function* recordScoped(transaction) {
              // Native server observation scope, not an invented authenticated principal or a global RLS bypass.
              yield* transaction.execute(
                sql`select set_config('ontos.tenant_id', ${row.tenantId}, true), set_config('ontos.legal_entity_id', ${row.legalEntityId}, true)`,
              );
              yield* transaction.insert(auditEvents).values(row);
            }),
          );
        },
        Effect.mapError(
          (cause) =>
            new OAuthAuthenticationAuditUnavailable({
              cause,
              reason: 'Unable to persist the OAuth authentication observation',
            }),
        ),
      ),
    };
  }),
);
