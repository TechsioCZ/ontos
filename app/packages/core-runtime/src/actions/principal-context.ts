import { Schema } from 'effect';

import { decodedStringBrand, nonEmptyString } from './string-schemas.ts';

const uuid = Schema.String.check(Schema.isUUID());
const AuthBindingIdSchema = decodedStringBrand(uuid, 'AuthBindingId');
const AuthenticationNamespaceIdSchema = decodedStringBrand(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200), Schema.isTrimmed()),
  'AuthenticationNamespaceId',
);
const ImpersonatedByPrincipalIdSchema = decodedStringBrand(uuid, 'ImpersonatedByPrincipalId');
const DelegatedByPrincipalIdSchema = decodedStringBrand(uuid, 'DelegatedByPrincipalId');
const LegalEntityIdSchema = decodedStringBrand(uuid, 'LegalEntityId');
const PrincipalIdSchema = decodedStringBrand(uuid, 'PrincipalId');
const TenantIdSchema = decodedStringBrand(uuid, 'TenantId');
const TrustedStorefrontIdSchema = decodedStringBrand(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  'TrustedStorefrontId',
);

const ConnectionModuleGrantSchema = Schema.Struct({
  access: Schema.Literals(['read', 'write']),
  moduleId: nonEmptyString.check(Schema.isMaxLength(120)),
});

/** What an MCP OAuth connection may do (ONTOS-MCP-AUTH-DESIGN.md §4.3); only with authMethod 'oauth_connection'. */
export const OAuthConnectionContextSchema = Schema.Struct({
  clientId: nonEmptyString.check(Schema.isMaxLength(500)),
  clientName: nonEmptyString.check(Schema.isMaxLength(200)),
  grantId: decodedStringBrand(uuid, 'OAuthGrantId'),
  modules: Schema.Union([
    Schema.Literal('all'),
    Schema.Array(ConnectionModuleGrantSchema).check(Schema.isMaxLength(100)),
  ]),
  writePolicy: Schema.Literals(['read_only', 'approval', 'direct']),
});
export type OAuthConnectionContext = typeof OAuthConnectionContextSchema.Type;

const TrustedPrincipalContextFieldsSchema = Schema.Struct({
  authBindingId: Schema.optionalKey(AuthBindingIdSchema),
  authContextRef: Schema.optionalKey(nonEmptyString.check(Schema.isMaxLength(500))),
  authenticationNamespaceId: Schema.optionalKey(AuthenticationNamespaceIdSchema),
  authMethod: Schema.Literals(['session', 'api_key', 'system', 'support_impersonation', 'oauth_connection']),
  connection: Schema.optionalKey(OAuthConnectionContextSchema),
  delegatedByPrincipalId: Schema.optionalKey(DelegatedByPrincipalIdSchema),
  impersonatedByPrincipalId: Schema.optionalKey(ImpersonatedByPrincipalIdSchema),
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
  trustedStorefrontId: Schema.optionalKey(TrustedStorefrontIdSchema),
});

type TrustedPrincipalContextFields = typeof TrustedPrincipalContextFieldsSchema.Type;
type PrincipalContextValidator = (context: TrustedPrincipalContextFields) => readonly Schema.FilterIssue[];

const issue = (message: string): readonly Schema.FilterIssue[] => [{ issue: message, path: ['authMethod'] }];

const validateApiKeyContext: PrincipalContextValidator = (context) =>
  context.authBindingId === undefined ||
  context.authContextRef === undefined ||
  context.impersonatedByPrincipalId !== undefined
    ? issue('api_key context requires a binding and safe key reference')
    : [];

const validateSessionContext: PrincipalContextValidator = (context) =>
  context.authBindingId === undefined ||
  context.authContextRef === undefined ||
  context.impersonatedByPrincipalId !== undefined
    ? issue('session context requires a binding and safe session reference')
    : [];

const validateSupportImpersonationContext: PrincipalContextValidator = (context) =>
  context.authBindingId === undefined ||
  context.authContextRef === undefined ||
  context.impersonatedByPrincipalId === undefined ||
  context.impersonatedByPrincipalId === context.principalId
    ? issue('support impersonation requires distinct effective and original principals')
    : [];

const validateSystemContext: PrincipalContextValidator = (context) =>
  context.authBindingId !== undefined ||
  context.authenticationNamespaceId !== undefined ||
  context.impersonatedByPrincipalId !== undefined ||
  context.legalEntityId !== undefined ||
  context.trustedStorefrontId !== undefined ||
  !/^job:[^:]{1,100}:run:[^:]{1,200}$/u.test(context.authContextRef ?? '')
    ? issue('system context requires only a safe job/run reference')
    : [];

const validateOAuthConnectionContext: PrincipalContextValidator = (context) =>
  context.authBindingId === undefined ||
  context.connection === undefined ||
  context.legalEntityId === undefined ||
  context.impersonatedByPrincipalId !== undefined ||
  context.authContextRef !== `oauth-grant:${context.connection.grantId}` ||
  context.delegatedByPrincipalId === context.principalId
    ? issue(
        'oauth_connection context requires a binding, its grant reference, a legal entity and a distinct delegating principal',
      )
    : [];

const principalContextValidators = {
  api_key: validateApiKeyContext,
  oauth_connection: validateOAuthConnectionContext,
  session: validateSessionContext,
  support_impersonation: validateSupportImpersonationContext,
  system: validateSystemContext,
} satisfies Record<TrustedPrincipalContextFields['authMethod'], PrincipalContextValidator>;

export const TrustedPrincipalContextSchema = TrustedPrincipalContextFieldsSchema.check(
  Schema.makeFilter((context) => [
    ...principalContextValidators[context.authMethod](context),
    ...(context.authMethod !== 'oauth_connection' &&
    (context.connection !== undefined || context.delegatedByPrincipalId !== undefined)
      ? [{ issue: 'only oauth_connection contexts carry connection data', path: ['connection'] }]
      : []),
    ...(context.trustedStorefrontId !== undefined && context.legalEntityId === undefined
      ? [
          {
            issue: 'trusted Storefront context requires a legal entity',
            path: ['trustedStorefrontId'],
          },
        ]
      : []),
  ]),
);

export type TrustedPrincipalContext = Schema.Schema.Type<typeof TrustedPrincipalContextSchema>;

/** Validates company scope without replacing the original admitted carrier. */
export const TrustedCompanyPrincipalContextSchema = Schema.Struct({
  ...TrustedPrincipalContextSchema.fields,
  legalEntityId: LegalEntityIdSchema.check(Schema.isUUID()),
}).check(
  Schema.makeFilter((context) =>
    Schema.is(TrustedPrincipalContextSchema)(context) ? undefined : 'A valid trusted company principal is required',
  ),
);
