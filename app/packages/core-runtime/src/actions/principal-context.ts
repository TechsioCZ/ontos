import { Schema } from 'effect';

const uuid = Schema.String.check(Schema.isUUID());
const nonEmptyString = Schema.String.check(Schema.isMinLength(1));
const AuthBindingIdSchema = uuid.pipe(
  Schema.brand('AuthBindingId'),
  Schema.decodeTo(Schema.String),
);
const ImpersonatedByPrincipalIdSchema = uuid.pipe(
  Schema.brand('ImpersonatedByPrincipalId'),
  Schema.decodeTo(Schema.String),
);
const LegalEntityIdSchema = uuid.pipe(
  Schema.brand('LegalEntityId'),
  Schema.decodeTo(Schema.String),
);
const PrincipalIdSchema = uuid.pipe(Schema.brand('PrincipalId'), Schema.decodeTo(Schema.String));
const TenantIdSchema = uuid.pipe(Schema.brand('TenantId'), Schema.decodeTo(Schema.String));

const TrustedPrincipalContextFieldsSchema = Schema.Struct({
  authBindingId: Schema.optionalKey(AuthBindingIdSchema),
  authContextRef: Schema.optionalKey(nonEmptyString),
  authMethod: Schema.Literals(['session', 'api_key', 'system', 'support_impersonation']),
  impersonatedByPrincipalId: Schema.optionalKey(ImpersonatedByPrincipalIdSchema),
  legalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  principalId: PrincipalIdSchema,
  tenantId: TenantIdSchema,
});

type TrustedPrincipalContextFields = typeof TrustedPrincipalContextFieldsSchema.Type;
type PrincipalContextValidator = (
  context: TrustedPrincipalContextFields,
) => readonly Schema.FilterIssue[];

const issue = (message: string): readonly Schema.FilterIssue[] => [
  { issue: message, path: ['authMethod'] },
];

const validateApiKeyContext: PrincipalContextValidator = (context) =>
  context.authBindingId === undefined ||
  context.authContextRef?.startsWith('better-auth-api-key:') !== true ||
  context.impersonatedByPrincipalId !== undefined
    ? issue('api_key context requires a binding and safe key reference')
    : [];

const validateSessionContext: PrincipalContextValidator = (context) =>
  context.authBindingId === undefined ||
  context.authContextRef?.startsWith('better-auth-session:') !== true ||
  context.impersonatedByPrincipalId !== undefined
    ? issue('session context requires a binding and safe session reference')
    : [];

const validateSupportImpersonationContext: PrincipalContextValidator = (context) =>
  context.authBindingId === undefined ||
  context.authContextRef?.startsWith('better-auth-session:') !== true ||
  context.impersonatedByPrincipalId === undefined ||
  context.impersonatedByPrincipalId === context.principalId
    ? issue('support impersonation requires distinct effective and original principals')
    : [];

const validateSystemContext: PrincipalContextValidator = (context) =>
  context.authBindingId !== undefined ||
  context.impersonatedByPrincipalId !== undefined ||
  context.legalEntityId !== undefined ||
  !/^job:[^:]{1,100}:run:[^:]{1,200}$/u.test(context.authContextRef ?? '')
    ? issue('system context requires only a safe job/run reference')
    : [];

const principalContextValidators = {
  api_key: validateApiKeyContext,
  session: validateSessionContext,
  support_impersonation: validateSupportImpersonationContext,
  system: validateSystemContext,
} satisfies Record<TrustedPrincipalContextFields['authMethod'], PrincipalContextValidator>;

export const TrustedPrincipalContextSchema = TrustedPrincipalContextFieldsSchema.check(
  Schema.makeFilter((context) => principalContextValidators[context.authMethod](context)),
);

export type TrustedPrincipalContext = Schema.Schema.Type<typeof TrustedPrincipalContextSchema>;
