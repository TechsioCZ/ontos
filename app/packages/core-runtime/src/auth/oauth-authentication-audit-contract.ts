import { Effect, Schema } from 'effect';

import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import { decodedStringBrand, transportIdentifier } from '../actions/string-schemas.ts';

const { principalId } = TrustedPrincipalContextSchema.fields;
const nullableText = Schema.Union([Schema.String, Schema.Null]);
const nullablePrincipalId = Schema.Union([principalId, Schema.Null]);
const writePolicy = Schema.Literals(['read_only', 'approval', 'direct']);
const clientKind = Schema.Literals(['cimd', 'loopback']);
const clientId = decodedStringBrand(Schema.String, 'OAuthClientId');
export const OAuthConnectionRevokeReasonSchema = Schema.Literals([
  'user',
  'admin',
  'superseded',
  'operator_removed',
  'agent_disabled',
  'user_disabled',
  'password_changed',
]);

/** Only server-retained grant facts enter the authentication observer; never credential/token material. */
export const OAuthAuditGrantSchema = Schema.Struct({
  clientId,
  clientName: Schema.String,
  grantId: decodedStringBrand(Schema.String.check(Schema.isUUID()), 'OAuthConnectionGrantId'),
  legalEntityId: decodedStringBrand(Schema.String.check(Schema.isUUID()), 'LegalEntityId'),
  tenantId: TrustedPrincipalContextSchema.fields.tenantId,
  userPrincipalId: principalId,
});
const attribution = {
  authBindingId: Schema.Union([decodedStringBrand(Schema.String.check(Schema.isUUID()), 'AuthBindingId'), Schema.Null]),
  principalId: nullablePrincipalId,
};
const request = Schema.Struct({
  authContextRef: TrustedPrincipalContextSchema.fields.authContextRef,
  correlationId: Schema.optionalKey(decodedStringBrand(transportIdentifier, 'CorrelationId')),
  impersonatedByPrincipalId: TrustedPrincipalContextSchema.fields.impersonatedByPrincipalId,
  requestId: Schema.optionalKey(decodedStringBrand(transportIdentifier, 'RequestId')),
  traceId: Schema.optionalKey(decodedStringBrand(transportIdentifier, 'TraceId')),
});
const common = { ...attribution, grant: OAuthAuditGrantSchema, request: Schema.optionalKey(request) };

/** Finite observations, not an arbitrary audit JSON writer or an Action-admission capability. */
export const OAuthAuthenticationObservationSchema = Schema.Union([
  Schema.Struct({
    ...common,
    authMethod: Schema.Literal('session'),
    eventType: Schema.Literal('oauth.connection.created'),
    evidence: Schema.Struct({
      actingPrincipalId: principalId,
      clientKind,
      delegatedByPrincipalId: nullablePrincipalId,
      legalEntityId: OAuthAuditGrantSchema.fields.legalEntityId,
      modules: Schema.String,
      writePolicy,
    }),
    outcome: Schema.Literal('succeeded'),
    outcomeCode: Schema.Literal('connection_created'),
  }),
  Schema.Struct({
    ...common,
    authMethod: Schema.Literal('session'),
    eventType: Schema.Literal('oauth.connection.updated'),
    evidence: Schema.Struct({
      modulesAfter: Schema.String,
      modulesBefore: Schema.String,
      writePolicyAfter: writePolicy,
      writePolicyBefore: writePolicy,
    }),
    outcome: Schema.Literal('succeeded'),
    outcomeCode: Schema.Literal('updated'),
  }),
  Schema.Struct({
    ...common,
    authMethod: Schema.Literals(['session', 'system']),
    eventType: Schema.Literal('oauth.connection.revoked'),
    evidence: Schema.Struct({
      note: nullableText,
      reason: OAuthConnectionRevokeReasonSchema,
      revokedByPrincipalId: nullablePrincipalId,
    }),
    outcome: Schema.Literal('succeeded'),
    outcomeCode: OAuthConnectionRevokeReasonSchema,
  }),
  Schema.Struct({
    ...common,
    authMethod: Schema.Literal('session'),
    eventType: Schema.Literal('oauth.connection.denied'),
    evidence: Schema.Struct({ actingPrincipalId: principalId, clientKind }),
    outcome: Schema.Literal('denied'),
    outcomeCode: Schema.Literal('access_denied'),
  }),
  Schema.Struct({
    ...common,
    authMethod: Schema.Literal('oauth_connection'),
    eventType: Schema.Literal('authn.connector_exchange'),
    evidence: Schema.Struct({ operation: Schema.Literal('mcp') }),
    outcome: Schema.Literal('succeeded'),
    outcomeCode: Schema.Literal('connector_exchange'),
  }),
  Schema.Struct({
    ...common,
    authMethod: Schema.Literal('oauth_refresh_token'),
    eventType: Schema.Literal('oauth.token.refresh_reuse'),
    evidence: Schema.Struct({
      clientId,
      grantStatusBefore: Schema.Literals(['draft', 'active', 'denied', 'revoked', 'superseded']),
      refreshTokenId: decodedStringBrand(Schema.String, 'OAuthRefreshTokenId'),
    }),
    outcome: Schema.Literal('denied'),
    outcomeCode: Schema.Literal('refresh_reuse'),
  }),
]);
export type OAuthAuthenticationObservation = typeof OAuthAuthenticationObservationSchema.Type;

/** Project the retained grant before strict decoding, so a full native grant row can be supplied structurally. */
export const oauthAuthenticationAuditRow = (observation: OAuthAuthenticationObservation) =>
  Schema.decodeUnknownEffect(OAuthAuthenticationObservationSchema, { onExcessProperty: 'error' })({
    ...observation,
    grant: {
      clientId: observation.grant.clientId,
      clientName: observation.grant.clientName,
      grantId: observation.grant.grantId,
      legalEntityId: observation.grant.legalEntityId,
      tenantId: observation.grant.tenantId,
      userPrincipalId: observation.grant.userPrincipalId,
    },
  }).pipe(
    Effect.map((input) => {
      const { authContextRef, impersonatedByPrincipalId, ...requestEvidence } = input.request ?? {};
      return {
        auditProfile: 'sensitive' as const,
        authBindingId: input.authBindingId,
        authContextRef,
        authMethod: input.authMethod,
        eventType: input.eventType,
        evidenceJson: {
          clientId: input.grant.clientId,
          clientName: input.grant.clientName,
          grantId: input.grant.grantId,
          userPrincipalId: input.grant.userPrincipalId,
          ...input.evidence,
          ...requestEvidence,
        },
        impersonatedByPrincipalId,
        legalEntityId: input.grant.legalEntityId,
        outcome: input.outcome,
        outcomeCode: input.outcomeCode,
        outcomeStage:
          input.eventType === 'authn.connector_exchange' || input.eventType === 'oauth.token.refresh_reuse'
            ? ('authn' as const)
            : ('execution' as const),
        principalId: input.principalId,
        targetModuleKey: 'core.identity',
        targetResourceId: input.grant.grantId,
        targetResourceType: 'oauth_connection_grant',
        tenantId: input.grant.tenantId,
      };
    }),
  );
