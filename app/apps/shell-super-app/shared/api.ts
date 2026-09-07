import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { GatewayContextApiGroup } from '@app/shared-contracts';

export type SafeTenantIdentity = typeof SafeTenantIdentitySchema.Type;
export type SafeAuthenticatedIdentity = typeof SafeAuthenticatedIdentitySchema.Type;
export type AnonymousSession = typeof AnonymousSessionSchema.Type;
export type AuthenticatedSession = typeof AuthenticatedSessionSchema.Type;
export type LegalEntityChoice = typeof LegalEntityChoiceSchema.Type;
export type SelectionRequiredSession = typeof SelectionRequiredSessionSchema.Type;
export type AccessBlockedSession = typeof AccessBlockedSessionSchema.Type;
export type CurrentSession = typeof CurrentSessionSchema.Type;
export type SignInPayload = typeof SignInPayloadSchema.Type;
export type SignInResponse = typeof SignInResponseSchema.Type;
export type SignOutResponse = typeof SignOutResponseSchema.Type;
export type AvailableTenant = typeof AvailableTenantSchema.Type;
export type AvailableTenantsResponse = typeof AvailableTenantsResponseSchema.Type;
export type SwitchTenantPayload = typeof SwitchTenantPayloadSchema.Type;
export type SwitchTenantResponse = typeof SwitchTenantResponseSchema.Type;
export type AvailableLegalEntitiesResponse = typeof AvailableLegalEntitiesResponseSchema.Type;
export type SwitchLegalEntityPayload = typeof SwitchLegalEntityPayloadSchema.Type;
export type SwitchLegalEntityResponse = typeof SwitchLegalEntityResponseSchema.Type;
export type ShellNavigationItem = typeof ShellNavigationItemSchema.Type;
export type ShellUnavailableDeployment = typeof ShellUnavailableDeploymentSchema.Type;
export type ShellComposition = typeof ShellCompositionSchema.Type;
export type ResolveModuleTargetPayload = typeof ResolveModuleTargetPayloadSchema.Type;
export type ResolvedModuleTarget = typeof ResolvedModuleTargetSchema.Type;
export type ResourceRef = typeof ResourceRefSchema.Type;
export type ShellSearchResult = typeof ShellSearchResultSchema.Type;
export type ShellSearchPayload = typeof ShellSearchPayloadSchema.Type;
export type ShellSearchResponse = typeof ShellSearchResponseSchema.Type;
export type ShellResourceDetailField = typeof ShellResourceDetailFieldSchema.Type;
export type ShellTimelineEntry = typeof ShellTimelineEntrySchema.Type;
export type ShellResourceResponse = typeof ShellResourceResponseSchema.Type;
export type MediaAttachmentResponse = typeof MediaAttachmentResponseSchema.Type;

const SafePrincipalIdSchema = Schema.String.pipe(Schema.brand('PrincipalId'));
export const PrincipalIdSchema = SafePrincipalIdSchema.check(Schema.isUUID());
export const AuthBindingIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('AuthBindingId'),
);
const SafeTenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'));
export const TenantIdSchema = SafeTenantIdSchema.check(Schema.isUUID());
export const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('LegalEntityId'),
);
export const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
export const GroupKeySchema = Schema.String.pipe(Schema.brand('GroupKey'));
export const ModuleIdSchema = Schema.String.check(Schema.isMinLength(3)).pipe(
  Schema.brand('ModuleId'),
);
export const ComponentKeySchema = Schema.String.pipe(Schema.brand('ComponentKey'));
export const EntrypointKeySchema = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(Schema.brand('EntrypointKey'));
export const ResourceIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('ResourceId'));
export const TimelineEntryIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('TimelineEntryId'));

export const IdentityRequestHeadersSchema = Schema.Struct({
  'idempotency-key': Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  ),
});
export const CreateNonHumanPrincipalPayloadSchema = Schema.Struct({
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  kind: Schema.Literals(['service', 'integration', 'system']),
});
const principalStatus = Schema.Literals(['active', 'disabled', 'archived']);
const identityReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500));
export const ChangePrincipalStatusPayloadSchema = Schema.Union([
  Schema.Struct({
    expectedStatus: principalStatus,
    newStatus: Schema.Literal('active'),
    principalId: PrincipalIdSchema,
    reason: Schema.optionalKey(identityReason),
  }),
  Schema.Struct({
    expectedStatus: principalStatus,
    newStatus: Schema.Literals(['disabled', 'archived']),
    principalId: PrincipalIdSchema,
    reason: identityReason,
  }),
]);
export const IssueApiKeyPayloadSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
});
export const IssueManagedApiKeyPayloadSchema = Schema.Struct({
  ...IssueApiKeyPayloadSchema.fields,
  principalId: PrincipalIdSchema,
});
const MutableApiKeyBindingStatusSchema = Schema.Literals(['active', 'disabled']);
const apiKeyStatusFields = {
  authBindingId: AuthBindingIdSchema,
  expectedStatus: MutableApiKeyBindingStatusSchema,
};
export const SetApiKeyStatusPayloadSchema = Schema.Union([
  Schema.Struct({
    ...apiKeyStatusFields,
    newStatus: MutableApiKeyBindingStatusSchema,
    reason: Schema.optionalKey(identityReason),
  }),
  Schema.Struct({
    ...apiKeyStatusFields,
    newStatus: Schema.Literal('revoked'),
    reason: identityReason,
  }),
]);
export const SetManagedApiKeyStatusPayloadSchema = Schema.Union([
  Schema.Struct({
    ...apiKeyStatusFields,
    newStatus: MutableApiKeyBindingStatusSchema,
    principalId: PrincipalIdSchema,
    reason: Schema.optionalKey(identityReason),
  }),
  Schema.Struct({
    ...apiKeyStatusFields,
    newStatus: Schema.Literal('revoked'),
    principalId: PrincipalIdSchema,
    reason: identityReason,
  }),
]);
export const RotateApiKeyPayloadSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
  oldAuthBindingId: AuthBindingIdSchema,
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export const RotateManagedApiKeyPayloadSchema = Schema.Struct({
  ...RotateApiKeyPayloadSchema.fields,
  principalId: PrincipalIdSchema,
});
export const ApiKeyLifecycleResponseSchema = Schema.Struct({
  authBindingId: AuthBindingIdSchema,
  cleanupPending: Schema.Boolean,
  createdAt: Schema.DateTimeUtcFromString,
  enabled: Schema.Boolean,
  expiresAt: Schema.Union([Schema.Null, Schema.DateTimeUtcFromString]),
  name: Schema.Union([Schema.Null, Schema.String]),
  start: Schema.Union([Schema.Null, Schema.String]),
});
export const ApiKeyIssueResponseSchema = Schema.Struct({
  ...ApiKeyLifecycleResponseSchema.fields,
  secret: Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
});
export const IdentityListPayloadSchema = Schema.Struct({
  limit: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 100, minimum: 1 })),
  offset: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export const SelfApiKeyListResponseSchema = Schema.Struct({
  items: Schema.Array(ApiKeyLifecycleResponseSchema),
  nextOffset: Schema.Union([Schema.Null, Schema.Finite]),
});
export const ManagedApiKeyListItemSchema = Schema.Struct({
  displayName: Schema.String,
  key: Schema.Union([Schema.Null, ApiKeyLifecycleResponseSchema]),
  kind: Schema.Literals(['service', 'integration']),
  principalId: PrincipalIdSchema,
  principalStatus,
});
export const ManagedApiKeyListResponseSchema = Schema.Struct({
  items: Schema.Array(ManagedApiKeyListItemSchema),
  nextOffset: Schema.Union([Schema.Null, Schema.Finite]),
});
export const PrincipalMutationResponseSchema = Schema.Struct({
  principalId: Schema.optionalKey(PrincipalIdSchema),
  status: Schema.String,
});
export const StartSupportImpersonationPayloadSchema = Schema.Struct({
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  targetPrincipalId: PrincipalIdSchema,
});
export const SupportImpersonationResponseSchema = Schema.Struct({
  active: Schema.Boolean,
  targetPrincipalId: Schema.optionalKey(PrincipalIdSchema),
});

export type CreateNonHumanPrincipalPayload = Schema.Schema.Type<
  typeof CreateNonHumanPrincipalPayloadSchema
>;
export type ChangePrincipalStatusPayload = Schema.Schema.Type<
  typeof ChangePrincipalStatusPayloadSchema
>;
export type IssueApiKeyPayload = Schema.Schema.Type<typeof IssueApiKeyPayloadSchema>;
export type IssueManagedApiKeyPayload = Schema.Schema.Type<typeof IssueManagedApiKeyPayloadSchema>;
export type SetApiKeyStatusPayload = Schema.Schema.Type<typeof SetApiKeyStatusPayloadSchema>;
export type SetManagedApiKeyStatusPayload = Schema.Schema.Type<
  typeof SetManagedApiKeyStatusPayloadSchema
>;
export type RotateApiKeyPayload = Schema.Schema.Type<typeof RotateApiKeyPayloadSchema>;
export type RotateManagedApiKeyPayload = Schema.Schema.Type<
  typeof RotateManagedApiKeyPayloadSchema
>;
export type IdentityListPayload = Schema.Schema.Type<typeof IdentityListPayloadSchema>;
export type ApiKeyLifecycleResponse = Schema.Schema.Type<typeof ApiKeyLifecycleResponseSchema>;
export type ApiKeyIssueResponse = Schema.Schema.Type<typeof ApiKeyIssueResponseSchema>;
export type PrincipalMutationResponse = Schema.Schema.Type<typeof PrincipalMutationResponseSchema>;
export type SelfApiKeyListResponse = Schema.Schema.Type<typeof SelfApiKeyListResponseSchema>;
export type ManagedApiKeyListResponse = Schema.Schema.Type<typeof ManagedApiKeyListResponseSchema>;
export type StartSupportImpersonationPayload = Schema.Schema.Type<
  typeof StartSupportImpersonationPayloadSchema
>;
export type SupportImpersonationResponse = Schema.Schema.Type<
  typeof SupportImpersonationResponseSchema
>;

export type InvalidCredentialsProblem = typeof InvalidCredentialsProblemSchema.Type;
export type OntosIdentityForbiddenProblem = typeof OntosIdentityForbiddenProblemSchema.Type;
export type AuthenticationUnavailableProblem = typeof AuthenticationUnavailableProblemSchema.Type;
export type AuthenticationInternalProblem = typeof AuthenticationInternalProblemSchema.Type;

export type AuthenticationProblem =
  | InvalidCredentialsProblem
  | OntosIdentityForbiddenProblem
  | AuthenticationUnavailableProblem
  | AuthenticationInternalProblem;

export type TenantAuthenticationRequiredProblem =
  typeof TenantAuthenticationRequiredProblemSchema.Type;
export type TenantAccessForbiddenProblem = typeof TenantAccessForbiddenProblemSchema.Type;
export type TenantCapabilityUnavailableProblem =
  typeof TenantCapabilityUnavailableProblemSchema.Type;
export type TenantInternalProblem = typeof TenantInternalProblemSchema.Type;

export type AvailableTenantsProblem =
  | TenantAuthenticationRequiredProblem
  | TenantCapabilityUnavailableProblem
  | TenantInternalProblem;

export type SwitchTenantProblem = AvailableTenantsProblem | TenantAccessForbiddenProblem;

export type LegalEntityAccessForbiddenProblem = typeof LegalEntityAccessForbiddenProblemSchema.Type;

export type LegalEntityProblem = AvailableTenantsProblem | LegalEntityAccessForbiddenProblem;

export type ShellAuthenticationRequiredProblem =
  typeof ShellAuthenticationRequiredProblemSchema.Type;
export type ShellTargetForbiddenProblem = typeof ShellTargetForbiddenProblemSchema.Type;
export type ShellTargetNotFoundProblem = typeof ShellTargetNotFoundProblemSchema.Type;
export type ShellSelectionRequiredProblem = typeof ShellSelectionRequiredProblemSchema.Type;
export type ShellPolicyConflictProblem = typeof ShellPolicyConflictProblemSchema.Type;
export type ShellPolicyUnprocessableProblem = typeof ShellPolicyUnprocessableProblemSchema.Type;
export type ShellInvalidRequestProblem = typeof ShellInvalidRequestProblemSchema.Type;
export type ShellPreconditionRequiredProblem = typeof ShellPreconditionRequiredProblemSchema.Type;
export type ShellCapabilityUnavailableProblem = typeof ShellCapabilityUnavailableProblemSchema.Type;
export type ShellInternalProblem = typeof ShellInternalProblemSchema.Type;
export type ShellRateLimitedProblem = typeof ShellRateLimitedProblemSchema.Type;

export type IdentityProblem =
  | ShellAuthenticationRequiredProblem
  | ShellTargetForbiddenProblem
  | ShellTargetNotFoundProblem
  | ShellInvalidRequestProblem
  | ShellPreconditionRequiredProblem
  | ShellPolicyConflictProblem
  | ShellPolicyUnprocessableProblem
  | ShellRateLimitedProblem
  | ShellCapabilityUnavailableProblem
  | ShellInternalProblem;

export type ShellCompositionProblem =
  | ShellAuthenticationRequiredProblem
  | ShellCapabilityUnavailableProblem
  | ShellInternalProblem;

export type ShellTargetProblem =
  | ShellAuthenticationRequiredProblem
  | ShellCapabilityUnavailableProblem
  | ShellInternalProblem
  | ShellPolicyConflictProblem
  | ShellPolicyUnprocessableProblem
  | ShellSelectionRequiredProblem
  | ShellTargetForbiddenProblem
  | ShellTargetNotFoundProblem;

const safeTenantIdentityFields = {
  displayName: Schema.String,
  email: Schema.String,
  impersonating: Schema.optionalKey(Schema.Literal(true)),
  principalId: SafePrincipalIdSchema,
  tenantId: SafeTenantIdSchema,
};

export const SafeTenantIdentitySchema = Schema.Struct(safeTenantIdentityFields);

export const SafeAuthenticatedIdentitySchema = Schema.Struct({
  ...safeTenantIdentityFields,
  legalEntityId: LegalEntityIdSchema,
  legalName: Schema.String.check(Schema.isMinLength(1)),
});

export const LegalEntityChoiceSchema = Schema.Struct({
  legalEntityId: LegalEntityIdSchema,
  legalName: Schema.String.check(Schema.isMinLength(1)),
});

export const AnonymousSessionSchema = Schema.Struct({
  state: Schema.Literal('anonymous'),
});

export const AuthenticatedSessionSchema = Schema.Struct({
  identity: SafeAuthenticatedIdentitySchema,
  state: Schema.Literal('authenticated'),
});

export const SelectionRequiredSessionSchema = Schema.Struct({
  availableLegalEntities: Schema.Array(LegalEntityChoiceSchema),
  identity: SafeTenantIdentitySchema,
  state: Schema.Literal('selection_required'),
});

export const AccessBlockedSessionSchema = Schema.Struct({
  identity: SafeTenantIdentitySchema,
  state: Schema.Literal('access_blocked'),
});

export const CurrentSessionSchema = Schema.Union([
  AnonymousSessionSchema,
  AuthenticatedSessionSchema,
  SelectionRequiredSessionSchema,
  AccessBlockedSessionSchema,
]);

export const SignInPayloadSchema = Schema.Struct({
  email: Schema.String.check(Schema.isMinLength(1)),
  password: Schema.Redacted(Schema.String.check(Schema.isMinLength(1))),
});

export const SignInResponseSchema = Schema.Struct({
  identity: SafeTenantIdentitySchema,
});

export const SignOutResponseSchema = Schema.Struct({
  signedOut: Schema.Literal(true),
});

export const AvailableTenantSchema = Schema.Struct({
  name: Schema.String,
  tenantId: TenantIdSchema,
});

export const AvailableTenantsResponseSchema = Schema.Struct({
  tenants: Schema.Array(AvailableTenantSchema),
});

export const SwitchTenantPayloadSchema = Schema.Struct({
  tenantId: TenantIdSchema,
});

export const SwitchTenantResponseSchema = Schema.Struct({
  selectedTenantId: TenantIdSchema,
});

export const AvailableLegalEntitiesResponseSchema = Schema.Struct({
  legalEntities: Schema.Array(LegalEntityChoiceSchema),
  selectedLegalEntityId: Schema.optionalKey(LegalEntityIdSchema),
  state: Schema.Literals(['access_blocked', 'authenticated', 'selection_required']),
});

export const SwitchLegalEntityPayloadSchema = Schema.Struct({
  legalEntityId: LegalEntityIdSchema,
});

export const SwitchLegalEntityResponseSchema = Schema.Struct({
  selectedLegalEntityId: LegalEntityIdSchema,
});

export const ShellNavigationItemSchema = Schema.Struct({
  appId: AppIdSchema,
  enabled: Schema.Boolean,
  groupKey: GroupKeySchema,
  href: Schema.optionalKey(Schema.String),
  label: Schema.String,
  moduleId: ModuleIdSchema,
  order: Schema.Finite.check(Schema.isInt()),
  state: Schema.Literals(['active', 'deprecated', 'read_only']),
  unavailable: Schema.Boolean,
  writable: Schema.Boolean,
});

export const ShellUnavailableDeploymentSchema = Schema.Union([
  Schema.Struct({ appId: AppIdSchema, status: Schema.Literals(['disabled', 'revoked']) }),
  Schema.Struct({
    appId: AppIdSchema,
    reason: Schema.Literals(['incompatible', 'timeout', 'unavailable']),
    status: Schema.Literal('unavailable'),
  }),
]);

export const ShellCompositionSchema = Schema.Union([
  Schema.Struct({ navigation: Schema.Tuple([]), state: Schema.Literal('access_blocked') }),
  Schema.Struct({ navigation: Schema.Tuple([]), state: Schema.Literal('selection_required') }),
  Schema.Struct({
    navigation: Schema.Array(ShellNavigationItemSchema),
    state: Schema.Literal('available'),
    unavailableDeployments: Schema.Array(ShellUnavailableDeploymentSchema),
  }),
]);

export const ResolveModuleTargetPayloadSchema = Schema.Struct({
  entrypointKey: Schema.optionalKey(EntrypointKeySchema),
  moduleId: ModuleIdSchema,
});

export const ResolvedModuleTargetSchema = Schema.Struct({
  appId: AppIdSchema,
  componentKey: ComponentKeySchema,
  entrypointKey: EntrypointKeySchema,
  moduleId: ModuleIdSchema,
  writable: Schema.Boolean,
});

export const ResourceRefSchema = Schema.Struct({
  moduleId: ModuleIdSchema,
  resourceId: ResourceIdSchema,
  resourceType: Schema.String.check(Schema.isMinLength(3)),
  tenantId: Schema.optionalKey(TenantIdSchema),
});

const searchTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const PartyRoleSchema = Schema.Literals(['CUSTOMER', 'SUPPLIER']);
const ShellSearchResultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('resource'), ref: ResourceRefSchema, title: searchTitle }),
  Schema.Struct({
    archived: Schema.Boolean,
    kind: Schema.Literal('party'),
    matchedViaAlias: Schema.Boolean,
    ref: ResourceRefSchema,
    title: searchTitle,
  }),
  Schema.Struct({
    collision: Schema.optionalKey(
      Schema.Struct({
        counterpartyRefs: Schema.Array(ResourceRefSchema),
        kind: Schema.Literal('CANONICAL_PARTY_COUNTERPARTY_COLLISION'),
      }),
    ),
    currentRoles: Schema.Array(PartyRoleSchema),
    kind: Schema.Literal('counterparty'),
    legalEntity: Schema.Struct({
      legalEntityId: LegalEntityIdSchema,
      tenantId: TenantIdSchema,
    }),
    party: Schema.Struct({
      archived: Schema.Boolean,
      matchedViaAlias: Schema.Boolean,
      ref: ResourceRefSchema,
      title: searchTitle,
    }),
    ref: ResourceRefSchema,
    title: searchTitle,
  }),
]);

export const ShellSearchPayloadSchema = Schema.Struct({
  includeArchived: Schema.optionalKey(Schema.Boolean),
  query: Schema.String.check(Schema.isMaxLength(300)),
  role: Schema.optionalKey(PartyRoleSchema),
});

export const ShellSearchResponseSchema = Schema.Struct({
  partial: Schema.Boolean,
  results: Schema.Array(ShellSearchResultSchema),
});

export const ShellResourceDetailFieldSchema = Schema.Struct({
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  value: Schema.String.check(Schema.isMaxLength(2000)),
});

export const ShellTimelineEntrySchema = Schema.Struct({
  occurredAt: Schema.DateTimeUtcFromString,
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  timelineEntryId: TimelineEntryIdSchema,
});

export const ShellResourceResponseSchema = Schema.Struct({
  detail: Schema.Struct({
    fields: Schema.Array(ShellResourceDetailFieldSchema),
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  }),
  media: Schema.Struct({
    enabled: Schema.Boolean,
    reason: Schema.Literals(['absent', 'available', 'forbidden', 'read_only', 'unavailable']),
  }),
  projectionLagging: Schema.Boolean,
  ref: ResourceRefSchema,
  timeline: Schema.Array(ShellTimelineEntrySchema),
});

export const MediaAttachmentResponseSchema = Schema.Struct({
  attached: Schema.Literal(true),
});

const authenticationProblemFields = {
  detail: Schema.String,
  status: Schema.Finite,
  title: Schema.String,
  type: Schema.String,
};

const asProblemDetails = HttpApiSchema.asJson({ contentType: 'application/problem+json' });

export const InvalidCredentialsProblemSchema = Schema.TaggedStruct('InvalidCredentialsProblem', {
  ...authenticationProblemFields,
}).pipe(asProblemDetails, HttpApiSchema.status(401));

export const OntosIdentityForbiddenProblemSchema = Schema.TaggedStruct(
  'OntosIdentityForbiddenProblem',
  {
    ...authenticationProblemFields,
  },
).pipe(asProblemDetails, HttpApiSchema.status(403));

export const AuthenticationUnavailableProblemSchema = Schema.TaggedStruct(
  'AuthenticationUnavailableProblem',
  {
    ...authenticationProblemFields,
  },
).pipe(asProblemDetails, HttpApiSchema.status(503));

export const AuthenticationInternalProblemSchema = Schema.TaggedStruct(
  'AuthenticationInternalProblem',
  {
    ...authenticationProblemFields,
  },
).pipe(asProblemDetails, HttpApiSchema.status(500));

export const TenantAuthenticationRequiredProblemSchema = Schema.TaggedStruct(
  'TenantAuthenticationRequiredProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(401));

export const TenantAccessForbiddenProblemSchema = Schema.TaggedStruct(
  'TenantAccessForbiddenProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(403));

export const TenantCapabilityUnavailableProblemSchema = Schema.TaggedStruct(
  'TenantCapabilityUnavailableProblem',
  {
    ...authenticationProblemFields,
    retryable: Schema.Literal(true),
  },
).pipe(asProblemDetails, HttpApiSchema.status(503));

export const TenantInternalProblemSchema = Schema.TaggedStruct(
  'TenantInternalProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(500));

export const LegalEntityAccessForbiddenProblemSchema = Schema.TaggedStruct(
  'LegalEntityAccessForbiddenProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(403));

export const ShellAuthenticationRequiredProblemSchema = Schema.TaggedStruct(
  'ShellAuthenticationRequiredProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(401));

export const ShellTargetForbiddenProblemSchema = Schema.TaggedStruct(
  'ShellTargetForbiddenProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(403));

export const ShellTargetNotFoundProblemSchema = Schema.TaggedStruct(
  'ShellTargetNotFoundProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(404));

export const ShellSelectionRequiredProblemSchema = Schema.TaggedStruct(
  'ShellSelectionRequiredProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(409));

export const ShellPolicyConflictProblemSchema = Schema.TaggedStruct(
  'ShellPolicyConflictProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(409));

export const ShellPolicyUnprocessableProblemSchema = Schema.TaggedStruct(
  'ShellPolicyUnprocessableProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(422));

export const ShellInvalidRequestProblemSchema = Schema.TaggedStruct(
  'ShellInvalidRequestProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(400));

export const ShellPreconditionRequiredProblemSchema = Schema.TaggedStruct(
  'ShellPreconditionRequiredProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(428));

export const ShellCapabilityUnavailableProblemSchema = Schema.TaggedStruct(
  'ShellCapabilityUnavailableProblem',
  { ...authenticationProblemFields, retryable: Schema.Literal(true) },
).pipe(asProblemDetails, HttpApiSchema.status(503));

export const ShellInternalProblemSchema = Schema.TaggedStruct(
  'ShellInternalProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(500));
export const ShellRateLimitedProblemSchema = Schema.TaggedStruct('ShellRateLimitedProblem', {
  ...authenticationProblemFields,
  retryAfterSeconds: Schema.Finite,
}).pipe(asProblemDetails, HttpApiSchema.status(429));

const identityErrors = [
  ShellAuthenticationRequiredProblemSchema,
  ShellTargetForbiddenProblemSchema,
  ShellTargetNotFoundProblemSchema,
  ShellInvalidRequestProblemSchema,
  ShellPreconditionRequiredProblemSchema,
  ShellPolicyConflictProblemSchema,
  ShellPolicyUnprocessableProblemSchema,
  ShellRateLimitedProblemSchema,
  ShellCapabilityUnavailableProblemSchema,
  ShellInternalProblemSchema,
] as const;

export const ShellAuthenticationApi = HttpApi.make('shellAuthenticationApi')
  .add(
    HttpApiGroup.make('authentication')
      .add(
        HttpApiEndpoint.post('signIn', '/auth/sign-in', {
          error: [
            InvalidCredentialsProblemSchema,
            OntosIdentityForbiddenProblemSchema,
            AuthenticationUnavailableProblemSchema,
            AuthenticationInternalProblemSchema,
          ],
          payload: SignInPayloadSchema,
          success: SignInResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.get('currentSession', '/auth/session', {
          error: [
            InvalidCredentialsProblemSchema,
            OntosIdentityForbiddenProblemSchema,
            AuthenticationUnavailableProblemSchema,
            AuthenticationInternalProblemSchema,
          ],
          success: CurrentSessionSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('signOut', '/auth/sign-out', {
          error: [
            InvalidCredentialsProblemSchema,
            OntosIdentityForbiddenProblemSchema,
            AuthenticationUnavailableProblemSchema,
            AuthenticationInternalProblemSchema,
          ],
          success: SignOutResponseSchema,
        }),
      ),
  )
  .add(
    HttpApiGroup.make('identity')
      .add(
        HttpApiEndpoint.post('createNonHumanPrincipal', '/auth/identity/principals', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: CreateNonHumanPrincipalPayloadSchema,
          success: PrincipalMutationResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('changePrincipalStatus', '/auth/identity/principal-status', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: ChangePrincipalStatusPayloadSchema,
          success: PrincipalMutationResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('issueSelfApiKey', '/auth/identity/api-keys/self', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: IssueApiKeyPayloadSchema,
          success: ApiKeyIssueResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('listSelfApiKeys', '/auth/identity/api-keys/self/list', {
          error: identityErrors,
          payload: IdentityListPayloadSchema,
          success: SelfApiKeyListResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('issueManagedApiKey', '/auth/identity/api-keys/managed', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: IssueManagedApiKeyPayloadSchema,
          success: ApiKeyIssueResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('listManagedApiKeys', '/auth/identity/api-keys/managed/list', {
          error: identityErrors,
          payload: IdentityListPayloadSchema,
          success: ManagedApiKeyListResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('setSelfApiKeyStatus', '/auth/identity/api-keys/self/status', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: SetApiKeyStatusPayloadSchema,
          success: ApiKeyLifecycleResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('setManagedApiKeyStatus', '/auth/identity/api-keys/managed/status', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: SetManagedApiKeyStatusPayloadSchema,
          success: ApiKeyLifecycleResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('rotateSelfApiKey', '/auth/identity/api-keys/self/rotate', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: RotateApiKeyPayloadSchema,
          success: ApiKeyIssueResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('rotateManagedApiKey', '/auth/identity/api-keys/managed/rotate', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: RotateManagedApiKeyPayloadSchema,
          success: ApiKeyIssueResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('startSupportImpersonation', '/auth/identity/impersonation/start', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: StartSupportImpersonationPayloadSchema,
          success: SupportImpersonationResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('stopSupportImpersonation', '/auth/identity/impersonation/stop', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          success: SupportImpersonationResponseSchema,
        }),
      ),
  )
  .add(
    HttpApiGroup.make('composition')
      .add(
        HttpApiEndpoint.get('shellComposition', '/shell/composition', {
          error: [
            ShellAuthenticationRequiredProblemSchema,
            ShellTargetForbiddenProblemSchema,
            ShellPolicyConflictProblemSchema,
            ShellPolicyUnprocessableProblemSchema,
            ShellCapabilityUnavailableProblemSchema,
            ShellInternalProblemSchema,
          ],
          success: ShellCompositionSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('resolveModuleTarget', '/shell/module-target', {
          error: [
            ShellAuthenticationRequiredProblemSchema,
            ShellTargetForbiddenProblemSchema,
            ShellTargetNotFoundProblemSchema,
            ShellPolicyConflictProblemSchema,
            ShellPolicyUnprocessableProblemSchema,
            ShellSelectionRequiredProblemSchema,
            ShellCapabilityUnavailableProblemSchema,
            ShellInternalProblemSchema,
          ],
          payload: ResolveModuleTargetPayloadSchema,
          success: ResolvedModuleTargetSchema,
        }),
      ),
  )
  .add(
    HttpApiGroup.make('legalEntities')
      .add(
        HttpApiEndpoint.get('availableLegalEntities', '/auth/legal-entities', {
          error: [
            TenantAuthenticationRequiredProblemSchema,
            TenantCapabilityUnavailableProblemSchema,
            TenantInternalProblemSchema,
          ],
          success: AvailableLegalEntitiesResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('switchLegalEntity', '/auth/legal-entity/switch', {
          error: [
            TenantAuthenticationRequiredProblemSchema,
            LegalEntityAccessForbiddenProblemSchema,
            TenantCapabilityUnavailableProblemSchema,
            TenantInternalProblemSchema,
          ],
          payload: SwitchLegalEntityPayloadSchema,
          success: SwitchLegalEntityResponseSchema,
        }),
      ),
  )
  .add(
    HttpApiGroup.make('tenants')
      .add(
        HttpApiEndpoint.get('availableTenants', '/auth/tenants', {
          error: [
            TenantAuthenticationRequiredProblemSchema,
            TenantCapabilityUnavailableProblemSchema,
            TenantInternalProblemSchema,
          ],
          success: AvailableTenantsResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('switchTenant', '/auth/tenant/switch', {
          error: [
            TenantAuthenticationRequiredProblemSchema,
            TenantAccessForbiddenProblemSchema,
            TenantCapabilityUnavailableProblemSchema,
            TenantInternalProblemSchema,
          ],
          payload: SwitchTenantPayloadSchema,
          success: SwitchTenantResponseSchema,
        }),
      ),
  )
  .add(
    HttpApiGroup.make('resources')
      .add(
        HttpApiEndpoint.post('search', '/shell/search', {
          error: [
            ShellAuthenticationRequiredProblemSchema,
            ShellTargetForbiddenProblemSchema,
            ShellPolicyConflictProblemSchema,
            ShellPolicyUnprocessableProblemSchema,
            ShellSelectionRequiredProblemSchema,
            ShellCapabilityUnavailableProblemSchema,
            ShellInternalProblemSchema,
          ],
          payload: ShellSearchPayloadSchema,
          success: ShellSearchResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('resourceDetail', '/shell/resource', {
          error: [
            ShellAuthenticationRequiredProblemSchema,
            ShellTargetForbiddenProblemSchema,
            ShellTargetNotFoundProblemSchema,
            ShellPolicyConflictProblemSchema,
            ShellPolicyUnprocessableProblemSchema,
            ShellSelectionRequiredProblemSchema,
            ShellCapabilityUnavailableProblemSchema,
            ShellInternalProblemSchema,
          ],
          payload: ResourceRefSchema,
          success: ShellResourceResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('attachMedia', '/shell/resource/media-attachment', {
          error: [
            ShellAuthenticationRequiredProblemSchema,
            ShellTargetForbiddenProblemSchema,
            ShellTargetNotFoundProblemSchema,
            ShellPolicyConflictProblemSchema,
            ShellPolicyUnprocessableProblemSchema,
            ShellSelectionRequiredProblemSchema,
            ShellCapabilityUnavailableProblemSchema,
            ShellInternalProblemSchema,
          ],
          payload: ResourceRefSchema,
          success: MediaAttachmentResponseSchema,
        }),
      ),
  )
  .add(GatewayContextApiGroup);

export const shellAuthenticationApiContract = {
  apiPrefix: '/shell-super-app-api',
  availableLegalEntitiesPath: '/shell-super-app-api/auth/legal-entities',
  availableTenantsPath: '/shell-super-app-api/auth/tenants',
  changePrincipalStatusPath: '/shell-super-app-api/auth/identity/principal-status',
  compositionPath: '/shell-super-app-api/shell/composition',
  createNonHumanPrincipalPath: '/shell-super-app-api/auth/identity/principals',
  currentSessionPath: '/shell-super-app-api/auth/session',
  issueApiKeyGatewayContextPath: '/shell-super-app-api/auth/api-key/gateway-context',
  issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
  issueManagedApiKeyPath: '/shell-super-app-api/auth/identity/api-keys/managed',
  issueSelfApiKeyPath: '/shell-super-app-api/auth/identity/api-keys/self',
  listManagedApiKeysPath: '/shell-super-app-api/auth/identity/api-keys/managed/list',
  listSelfApiKeysPath: '/shell-super-app-api/auth/identity/api-keys/self/list',
  mediaAttachmentPath: '/shell-super-app-api/shell/resource/media-attachment',
  ownerId: 'shell-super-app',
  resolveModuleTargetPath: '/shell-super-app-api/shell/module-target',
  resourceDetailPath: '/shell-super-app-api/shell/resource',
  rotateManagedApiKeyPath: '/shell-super-app-api/auth/identity/api-keys/managed/rotate',
  rotateSelfApiKeyPath: '/shell-super-app-api/auth/identity/api-keys/self/rotate',
  searchPath: '/shell-super-app-api/shell/search',
  setManagedApiKeyStatusPath: '/shell-super-app-api/auth/identity/api-keys/managed/status',
  setSelfApiKeyStatusPath: '/shell-super-app-api/auth/identity/api-keys/self/status',
  signInPath: '/shell-super-app-api/auth/sign-in',
  signOutPath: '/shell-super-app-api/auth/sign-out',
  startSupportImpersonationPath: '/shell-super-app-api/auth/identity/impersonation/start',
  stopSupportImpersonationPath: '/shell-super-app-api/auth/identity/impersonation/stop',
  switchLegalEntityPath: '/shell-super-app-api/auth/legal-entity/switch',
  switchTenantPath: '/shell-super-app-api/auth/tenant/switch',
} as const;
