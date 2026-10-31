import { and, eq, inArray } from 'drizzle-orm';
import { Context, Effect, Layer, Schema } from 'effect';

import { CoreDatabase } from '../db/client.ts';
import { legalEntities } from '../db/schema.ts';
import { OAuthAuthenticationAuditUnavailable } from './oauth-authentication-audit-unavailable.ts';

import { OAuthAuditGrantSchema } from './oauth-authentication-audit-contract.ts';

const querySchema = Schema.Struct({
  legalEntityIds: Schema.Array(OAuthAuditGrantSchema.fields.legalEntityId).check(Schema.isMaxLength(500)),
  tenantId: OAuthAuditGrantSchema.fields.tenantId,
});

/** Company labels for server-side OAuth grant descriptions, including retained inactive-company grants. */
export class OAuthConnectionCompanies extends Context.Service<
  OAuthConnectionCompanies,
  {
    readonly names: (
      tenantId: string,
      legalEntityIds: readonly string[],
    ) => Effect.Effect<ReadonlyMap<string, string>, OAuthAuthenticationAuditUnavailable>;
  }
>()('@app/core-runtime/auth/oauth-connection-companies/OAuthConnectionCompanies') {}

export const OAuthConnectionCompaniesLive = Layer.effect(
  OAuthConnectionCompanies,
  Effect.gen(function* oauthConnectionCompaniesService() {
    const { executor } = yield* CoreDatabase;
    return {
      names: Effect.fn('OAuthConnectionCompanies.names')(
        function* names(tenantId: string, legalEntityIds: readonly string[]) {
          const query = yield* Schema.decodeEffect(querySchema)({
            legalEntityIds: [...new Set(legalEntityIds)],
            tenantId,
          });
          if (query.legalEntityIds.length === 0) {
            return new Map<string, string>();
          }
          // Native credential-support lookup, like LegalEntityContext: only the exact retained grant companies.
          const rows = yield* executor
            .select({ legalEntityId: legalEntities.legalEntityId, legalName: legalEntities.legalName })
            .from(legalEntities)
            .where(
              and(
                eq(legalEntities.tenantId, query.tenantId),
                inArray(legalEntities.legalEntityId, query.legalEntityIds),
              ),
            );
          return new Map(rows.map((row) => [row.legalEntityId, row.legalName]));
        },
        Effect.mapError(
          (cause) =>
            new OAuthAuthenticationAuditUnavailable({
              cause,
              reason: 'Unable to describe the OAuth connection companies',
            }),
        ),
      ),
    };
  }),
);
