import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  Schema,
} from '@modern-js/plugin-bff/effect-client';
import { GatewayContextApiGroup } from '@app/shared-contracts';

export interface SafeTenantIdentity {
  readonly displayName: string;
  readonly email: string;
  readonly principalId: string;
  readonly tenantId: string;
  readonly impersonating?: true;
}

export interface SafeAuthenticatedIdentity extends SafeTenantIdentity {
  readonly legalEntityId: string;
  readonly legalName: string;
}

export interface AnonymousSession {
  readonly state: 'anonymous';
}

export interface AuthenticatedSession {
  readonly identity: SafeAuthenticatedIdentity;
  readonly state: 'authenticated';
}

export interface LegalEntityChoice {
  readonly legalEntityId: string;
  readonly legalName: string;
}

export interface SelectionRequiredSession {
  readonly availableLegalEntities: readonly LegalEntityChoice[];
  readonly identity: SafeTenantIdentity;
  readonly state: 'selection_required';
}

export interface AccessBlockedSession {
  readonly identity: SafeTenantIdentity;
  readonly state: 'access_blocked';
}

export type CurrentSession =
  | AccessBlockedSession
  | AnonymousSession
  | AuthenticatedSession
  | SelectionRequiredSession;

export interface SignInPayload {
  readonly email: string;
  readonly password: string;
}

export interface SignInResponse {
  readonly identity: SafeTenantIdentity;
}

export interface SignOutResponse {
  readonly signedOut: true;
}

export interface AvailableTenant {
  readonly name: string;
  readonly tenantId: string;
}

export interface AvailableTenantsResponse {
  readonly tenants: readonly AvailableTenant[];
}

export interface SwitchTenantPayload {
  readonly tenantId: string;
}

export interface SwitchTenantResponse {
  readonly selectedTenantId: string;
}

export interface AvailableLegalEntitiesResponse {
  readonly legalEntities: readonly LegalEntityChoice[];
  readonly selectedLegalEntityId?: string;
  readonly state: 'access_blocked' | 'authenticated' | 'selection_required';
}

export interface SwitchLegalEntityPayload {
  readonly legalEntityId: string;
}

export interface SwitchLegalEntityResponse {
  readonly selectedLegalEntityId: string;
}

export interface ShellNavigationItem {
  readonly appId: string;
  readonly enabled: boolean;
  readonly groupKey: string;
  readonly href?: string;
  readonly label: string;
  readonly moduleId: string;
  readonly order: number;
  readonly state: 'active' | 'deprecated' | 'read_only';
  readonly unavailable: boolean;
  readonly writable: boolean;
}

export type ShellComposition =
  | { readonly navigation: readonly []; readonly state: 'access_blocked' }
  | { readonly navigation: readonly []; readonly state: 'selection_required' }
  | { readonly navigation: readonly ShellNavigationItem[]; readonly state: 'available' };

export interface ResolveModuleTargetPayload {
  readonly entrypointKey?: string;
  readonly moduleId: string;
}

export interface ResolvedModuleTarget {
  readonly appId: string;
  readonly componentKey: string;
  readonly entrypointKey: string;
  readonly moduleId: string;
  readonly writable: boolean;
}

export interface ResourceRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

export interface ShellSearchResult {
  readonly ref: ResourceRef;
  readonly title: string;
}

export interface ShellSearchPayload {
  readonly query: string;
}

export interface ShellSearchResponse {
  readonly partial: boolean;
  readonly results: readonly ShellSearchResult[];
}

export interface ShellResourceDetailField {
  readonly label: string;
  readonly value: string;
}

export interface ShellTimelineEntry {
  readonly occurredAt: string;
  readonly summary: string;
  readonly timelineEntryId: string;
}

export interface ShellResourceResponse {
  readonly detail: {
    readonly fields: readonly ShellResourceDetailField[];
    readonly title: string;
  };
  readonly media: {
    readonly enabled: boolean;
    readonly reason: 'absent' | 'available' | 'forbidden' | 'read_only' | 'unavailable';
  };
  readonly projectionLagging: boolean;
  readonly ref: ResourceRef;
  readonly timeline: readonly ShellTimelineEntry[];
}

export interface MediaAttachmentResponse {
  readonly attached: true;
}

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
    principalId: Schema.String.check(Schema.isUUID()),
    reason: Schema.optionalKey(identityReason),
  }),
  Schema.Struct({
    expectedStatus: principalStatus,
    newStatus: Schema.Literals(['disabled', 'archived']),
    principalId: Schema.String.check(Schema.isUUID()),
    reason: identityReason,
  }),
]);
export const IssueApiKeyPayloadSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
});
export const IssueManagedApiKeyPayloadSchema = Schema.Struct({
  ...IssueApiKeyPayloadSchema.fields,
  principalId: Schema.String.check(Schema.isUUID()),
});
const MutableApiKeyBindingStatusSchema = Schema.Literals(['active', 'disabled']);
const apiKeyStatusFields = {
  authBindingId: Schema.String.check(Schema.isUUID()),
  expectedStatus: MutableApiKeyBindingStatusSchema,
};
export const SetApiKeyStatusPayloadSchema = Schema.Union([
  Schema.Struct({
    ...apiKeyStatusFields,
    newStatus: Schema.Literals(['active', 'disabled']),
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
    newStatus: Schema.Literals(['active', 'disabled']),
    principalId: Schema.String.check(Schema.isUUID()),
    reason: Schema.optionalKey(identityReason),
  }),
  Schema.Struct({
    ...apiKeyStatusFields,
    newStatus: Schema.Literal('revoked'),
    principalId: Schema.String.check(Schema.isUUID()),
    reason: identityReason,
  }),
]);
export const RotateApiKeyPayloadSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32))),
  oldAuthBindingId: Schema.String.check(Schema.isUUID()),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
});
export const RotateManagedApiKeyPayloadSchema = Schema.Struct({
  ...RotateApiKeyPayloadSchema.fields,
  principalId: Schema.String.check(Schema.isUUID()),
});
export const ApiKeyLifecycleResponseSchema = Schema.Struct({
  authBindingId: Schema.String.check(Schema.isUUID()),
  cleanupPending: Schema.Boolean,
  createdAt: Schema.String,
  enabled: Schema.Boolean,
  expiresAt: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  start: Schema.NullOr(Schema.String),
});
export const ApiKeyIssueResponseSchema = Schema.Struct({
  ...ApiKeyLifecycleResponseSchema.fields,
  secret: Schema.String.check(Schema.isMinLength(1)),
});
export const IdentityListPayloadSchema = Schema.Struct({
  limit: Schema.Finite.check(Schema.isInt(), Schema.isBetween({ maximum: 100, minimum: 1 })),
  offset: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export const SelfApiKeyListResponseSchema = Schema.Struct({
  items: Schema.Array(ApiKeyLifecycleResponseSchema),
  nextOffset: Schema.NullOr(Schema.Finite),
});
export const ManagedApiKeyListItemSchema = Schema.Struct({
  displayName: Schema.String,
  key: Schema.NullOr(ApiKeyLifecycleResponseSchema),
  kind: Schema.Literals(['service', 'integration']),
  principalId: Schema.String.check(Schema.isUUID()),
  principalStatus: Schema.Literals(['active', 'disabled', 'archived']),
});
export const ManagedApiKeyListResponseSchema = Schema.Struct({
  items: Schema.Array(ManagedApiKeyListItemSchema),
  nextOffset: Schema.NullOr(Schema.Finite),
});
export const PrincipalMutationResponseSchema = Schema.Struct({
  principalId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
  status: Schema.String,
});
export const StartSupportImpersonationPayloadSchema = Schema.Struct({
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  targetPrincipalId: Schema.String.check(Schema.isUUID()),
});
export const SupportImpersonationResponseSchema = Schema.Struct({
  active: Schema.Boolean,
  targetPrincipalId: Schema.optionalKey(Schema.String.check(Schema.isUUID())),
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

interface ProblemDetails {
  readonly detail: string;
  readonly status: number;
  readonly title: string;
  readonly type: string;
}

export interface InvalidCredentialsProblem extends ProblemDetails {
  readonly _tag: 'InvalidCredentialsProblem';
}

export interface OntosIdentityForbiddenProblem extends ProblemDetails {
  readonly _tag: 'OntosIdentityForbiddenProblem';
}

export interface AuthenticationUnavailableProblem extends ProblemDetails {
  readonly _tag: 'AuthenticationUnavailableProblem';
}

export interface AuthenticationInternalProblem extends ProblemDetails {
  readonly _tag: 'AuthenticationInternalProblem';
}

export type AuthenticationProblem =
  | InvalidCredentialsProblem
  | OntosIdentityForbiddenProblem
  | AuthenticationUnavailableProblem
  | AuthenticationInternalProblem;

export interface TenantAuthenticationRequiredProblem extends ProblemDetails {
  readonly _tag: 'TenantAuthenticationRequiredProblem';
}

export interface TenantAccessForbiddenProblem extends ProblemDetails {
  readonly _tag: 'TenantAccessForbiddenProblem';
}

export interface TenantCapabilityUnavailableProblem extends ProblemDetails {
  readonly _tag: 'TenantCapabilityUnavailableProblem';
  readonly retryable: true;
}

export interface TenantInternalProblem extends ProblemDetails {
  readonly _tag: 'TenantInternalProblem';
}

export type AvailableTenantsProblem =
  | TenantAuthenticationRequiredProblem
  | TenantCapabilityUnavailableProblem
  | TenantInternalProblem;

export type SwitchTenantProblem = AvailableTenantsProblem | TenantAccessForbiddenProblem;

export interface LegalEntityAccessForbiddenProblem extends ProblemDetails {
  readonly _tag: 'LegalEntityAccessForbiddenProblem';
}

export type LegalEntityProblem = AvailableTenantsProblem | LegalEntityAccessForbiddenProblem;

export interface ShellAuthenticationRequiredProblem extends ProblemDetails {
  readonly _tag: 'ShellAuthenticationRequiredProblem';
}

export interface ShellTargetForbiddenProblem extends ProblemDetails {
  readonly _tag: 'ShellTargetForbiddenProblem';
}

export interface ShellTargetNotFoundProblem extends ProblemDetails {
  readonly _tag: 'ShellTargetNotFoundProblem';
}

export interface ShellSelectionRequiredProblem extends ProblemDetails {
  readonly _tag: 'ShellSelectionRequiredProblem';
}

export interface ShellPolicyConflictProblem extends ProblemDetails {
  readonly _tag: 'ShellPolicyConflictProblem';
}

export interface ShellPolicyUnprocessableProblem extends ProblemDetails {
  readonly _tag: 'ShellPolicyUnprocessableProblem';
}

export interface ShellInvalidRequestProblem extends ProblemDetails {
  readonly _tag: 'ShellInvalidRequestProblem';
}

export interface ShellPreconditionRequiredProblem extends ProblemDetails {
  readonly _tag: 'ShellPreconditionRequiredProblem';
}

export interface ShellCapabilityUnavailableProblem extends ProblemDetails {
  readonly _tag: 'ShellCapabilityUnavailableProblem';
  readonly retryable: true;
}

export interface ShellInternalProblem extends ProblemDetails {
  readonly _tag: 'ShellInternalProblem';
}
export interface ShellRateLimitedProblem extends ProblemDetails {
  readonly _tag: 'ShellRateLimitedProblem';
  readonly retryAfterSeconds: number;
}

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
  principalId: Schema.String,
  tenantId: Schema.String,
};

export const SafeTenantIdentitySchema: Schema.Codec<SafeTenantIdentity> =
  Schema.Struct(safeTenantIdentityFields);

export const SafeAuthenticatedIdentitySchema: Schema.Codec<SafeAuthenticatedIdentity> =
  Schema.Struct({
    ...safeTenantIdentityFields,
    legalEntityId: Schema.String.check(Schema.isUUID()),
    legalName: Schema.String.check(Schema.isMinLength(1)),
  });

export const LegalEntityChoiceSchema: Schema.Codec<LegalEntityChoice> = Schema.Struct({
  legalEntityId: Schema.String.check(Schema.isUUID()),
  legalName: Schema.String.check(Schema.isMinLength(1)),
});

export const AnonymousSessionSchema: Schema.Codec<AnonymousSession> = Schema.Struct({
  state: Schema.Literal('anonymous'),
});

export const AuthenticatedSessionSchema: Schema.Codec<AuthenticatedSession> = Schema.Struct({
  identity: SafeAuthenticatedIdentitySchema,
  state: Schema.Literal('authenticated'),
});

export const SelectionRequiredSessionSchema: Schema.Codec<SelectionRequiredSession> = Schema.Struct(
  {
    availableLegalEntities: Schema.Array(LegalEntityChoiceSchema),
    identity: SafeTenantIdentitySchema,
    state: Schema.Literal('selection_required'),
  },
);

export const AccessBlockedSessionSchema: Schema.Codec<AccessBlockedSession> = Schema.Struct({
  identity: SafeTenantIdentitySchema,
  state: Schema.Literal('access_blocked'),
});

export const CurrentSessionSchema: Schema.Codec<CurrentSession> = Schema.Union([
  AnonymousSessionSchema,
  AuthenticatedSessionSchema,
  SelectionRequiredSessionSchema,
  AccessBlockedSessionSchema,
]);

export const SignInPayloadSchema: Schema.Codec<SignInPayload> = Schema.Struct({
  email: Schema.String.check(Schema.isMinLength(1)),
  password: Schema.String.check(Schema.isMinLength(1)),
});

export const SignInResponseSchema: Schema.Codec<SignInResponse> = Schema.Struct({
  identity: SafeTenantIdentitySchema,
});

export const SignOutResponseSchema: Schema.Codec<SignOutResponse> = Schema.Struct({
  signedOut: Schema.Literal(true),
});

const TenantIdSchema = Schema.String.check(Schema.isUUID());

export const AvailableTenantSchema: Schema.Codec<AvailableTenant> = Schema.Struct({
  name: Schema.String,
  tenantId: TenantIdSchema,
});

export const AvailableTenantsResponseSchema: Schema.Codec<AvailableTenantsResponse> = Schema.Struct(
  {
    tenants: Schema.Array(AvailableTenantSchema),
  },
);

export const SwitchTenantPayloadSchema: Schema.Codec<SwitchTenantPayload> = Schema.Struct({
  tenantId: TenantIdSchema,
});

export const SwitchTenantResponseSchema: Schema.Codec<SwitchTenantResponse> = Schema.Struct({
  selectedTenantId: TenantIdSchema,
});

export const AvailableLegalEntitiesResponseSchema: Schema.Codec<AvailableLegalEntitiesResponse> =
  Schema.Struct({
    legalEntities: Schema.Array(LegalEntityChoiceSchema),
    selectedLegalEntityId: Schema.optionalKey(TenantIdSchema),
    state: Schema.Literals(['access_blocked', 'authenticated', 'selection_required']),
  });

export const SwitchLegalEntityPayloadSchema: Schema.Codec<SwitchLegalEntityPayload> = Schema.Struct(
  {
    legalEntityId: TenantIdSchema,
  },
);

export const SwitchLegalEntityResponseSchema: Schema.Codec<SwitchLegalEntityResponse> =
  Schema.Struct({
    selectedLegalEntityId: TenantIdSchema,
  });

export const ShellNavigationItemSchema: Schema.Codec<ShellNavigationItem> = Schema.Struct({
  appId: Schema.String,
  enabled: Schema.Boolean,
  groupKey: Schema.String,
  href: Schema.optionalKey(Schema.String),
  label: Schema.String,
  moduleId: Schema.String,
  order: Schema.Finite.check(Schema.isInt()),
  state: Schema.Literals(['active', 'deprecated', 'read_only']),
  unavailable: Schema.Boolean,
  writable: Schema.Boolean,
});

export const ShellCompositionSchema: Schema.Codec<ShellComposition> = Schema.Union([
  Schema.Struct({ navigation: Schema.Tuple([]), state: Schema.Literal('access_blocked') }),
  Schema.Struct({ navigation: Schema.Tuple([]), state: Schema.Literal('selection_required') }),
  Schema.Struct({
    navigation: Schema.Array(ShellNavigationItemSchema),
    state: Schema.Literal('available'),
  }),
]);

export const ResolveModuleTargetPayloadSchema: Schema.Codec<ResolveModuleTargetPayload> =
  Schema.Struct({
    entrypointKey: Schema.optionalKey(
      Schema.String.check(
        Schema.isMinLength(3),
        Schema.isMaxLength(200),
        Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
      ),
    ),
    moduleId: Schema.String.check(Schema.isMinLength(3)),
  });

export const ResolvedModuleTargetSchema: Schema.Codec<ResolvedModuleTarget> = Schema.Struct({
  appId: Schema.String,
  componentKey: Schema.String,
  entrypointKey: Schema.String,
  moduleId: Schema.String,
  writable: Schema.Boolean,
});

export const ResourceRefSchema: Schema.Codec<ResourceRef> = Schema.Struct({
  moduleId: Schema.String.check(Schema.isMinLength(3)),
  resourceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  resourceType: Schema.String.check(Schema.isMinLength(3)),
});

const ShellSearchResultSchema: Schema.Codec<ShellSearchResult> = Schema.Struct({
  ref: ResourceRefSchema,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});

export const ShellSearchPayloadSchema: Schema.Codec<ShellSearchPayload> = Schema.Struct({
  query: Schema.String.check(Schema.isMaxLength(300)),
});

export const ShellSearchResponseSchema: Schema.Codec<ShellSearchResponse> = Schema.Struct({
  partial: Schema.Boolean,
  results: Schema.Array(ShellSearchResultSchema),
});

const ShellTimelineEntrySchema: Schema.Codec<ShellTimelineEntry> = Schema.Struct({
  occurredAt: Schema.String,
  summary: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  timelineEntryId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
});

export const ShellResourceResponseSchema: Schema.Codec<ShellResourceResponse> = Schema.Struct({
  detail: Schema.Struct({
    fields: Schema.Array(
      Schema.Struct({
        label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
        value: Schema.String.check(Schema.isMaxLength(2000)),
      }),
    ),
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

export const MediaAttachmentResponseSchema: Schema.Codec<MediaAttachmentResponse> = Schema.Struct({
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
