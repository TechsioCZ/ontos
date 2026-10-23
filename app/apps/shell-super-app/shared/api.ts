import { GatewayContextApiGroup } from '@app/shared-contracts';
import { ExternalIdentityApiGroup } from '@app/shared-contracts/external-identity';
import { makeProblemDetailsSchema, makeRetryableProblemDetailsSchema } from '@app/shared-contracts/problem-details';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, Schema } from '@modern-js/bff-effect/effect-client';
import {
  AgentActivityRequestSchema,
  AgentActivityResponseSchema,
  AgentDecideRequestSchema,
  AgentDecideResponseSchema,
  AgentProposalSubmitRequestSchema,
  AgentProposalSubmitResponseSchema,
  AgentQueueResponseSchema,
  AgentQueueRequestSchema,
  AgentRevertRequestSchema,
  AgentRevertResponseSchema,
} from '@app/shared-contracts/agent-proposals';
import {
  AgentEntityOverviewSchema,
  AgentOperatorsRequestSchema,
  AgentOperatorsResponseSchema,
  ConnectionAdminListRequestSchema,
  ConnectionAdminListResponseSchema,
  ConnectionListResponseSchema,
  ConnectionMutationResponseSchema,
  ConnectionRevokeRequestSchema,
  ConnectionUpdateRequestSchema,
  ManageAgentEntityRequestSchema,
  ManageAgentEntityResponseSchema,
} from '@app/shared-contracts/agent-access';
import { DocumentGatewayApiGroup, DocumentGatewayAssertionSchema } from './document-gateway-api.ts';
import { OAuthConnectApiGroup } from './oauth-connect-api.ts';
import {
  PEOPLE_PATHS,
  InvitePeopleRequestSchema,
  InvitePeopleResponseSchema,
  PeopleListRequestSchema,
  PeopleListResponseSchema,
  SetPeopleCompanyMembershipRequestSchema,
  SetPeopleCompanyMembershipResponseSchema,
  SetPeopleRoleRequestSchema,
  SetPeopleRoleResponseSchema,
} from './people-api.ts';
// @ontos-codesmith-core-read-contract-imports:start

// @ontos-core-read legal-entity-detail
import { LegalEntityDetailRequestSchema, LegalEntityDetailResponseSchema } from './core-reads/legal-entity-detail.ts';
// @ontos-codesmith-core-read-contract-imports:end

export type SafeTenantIdentity = typeof SafeTenantIdentitySchema.Type;
export type SafeAuthenticatedIdentity = typeof SafeAuthenticatedIdentitySchema.Type;
export type LegalEntityChoice = typeof LegalEntityChoiceSchema.Type;
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
export type SwitchToTenantContextResponse = typeof SwitchToTenantContextResponseSchema.Type;
export type ShellNavigationItem = typeof ShellNavigationItemSchema.Type;
export type ShellUnavailableDeployment = typeof ShellUnavailableDeploymentSchema.Type;
export type ShellComposition = typeof ShellCompositionSchema.Type;
export type ShellCompositionRequest = typeof ShellCompositionRequestSchema.Type;
export type ResolveModuleTargetPayload = typeof ResolveModuleTargetPayloadSchema.Type;
export type ResolvedModuleTarget = typeof ResolvedModuleTargetSchema.Type;
export type ResourceRef = typeof ResourceRefSchema.Type;
export type ShellResourceRequest = typeof ShellResourceRequestSchema.Type;
export type ShellSearchResult = typeof ShellSearchResultSchema.Type;
export type ShellSearchPayload = typeof ShellSearchPayloadSchema.Type;
export type ShellSearchResponse = typeof ShellSearchResponseSchema.Type;
export type ShellResourceResponse = typeof ShellResourceResponseSchema.Type;
export type MediaAttachmentResponse = typeof MediaAttachmentResponseSchema.Type;

const SafePrincipalIdSchema = Schema.String.pipe(Schema.brand('PrincipalId'));
export const PrincipalIdSchema = SafePrincipalIdSchema.check(Schema.isUUID());
export const AuthBindingIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('AuthBindingId'));
const SafeTenantIdSchema = Schema.String.pipe(Schema.brand('TenantId'));
export const TenantIdSchema = SafeTenantIdSchema.check(Schema.isUUID());
export const LegalEntityIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('LegalEntityId'));
export const AppIdSchema = Schema.String.pipe(Schema.brand('AppId'));
export const GroupKeySchema = Schema.String.pipe(Schema.brand('GroupKey'));
export const ModuleIdSchema = Schema.String.check(Schema.isMinLength(3)).pipe(Schema.brand('ModuleId'));
export const ComponentKeySchema = Schema.String.pipe(Schema.brand('ComponentKey'));
export const EntrypointKeySchema = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u),
).pipe(Schema.brand('EntrypointKey'));
export const ResourceIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
  Schema.brand('ResourceId'),
);
export const TimelineEntryIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
  Schema.brand('TimelineEntryId'),
);

export const IdentityRequestHeadersSchema = Schema.Struct({
  'idempotency-key': Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});
export const ConfigureDemoCompaniesPayloadSchema = Schema.Struct({ configuration: Schema.Literal('sales-rental-v1') });
export const ConfigureDemoCompaniesResponseSchema = Schema.Struct({
  companies: Schema.Array(
    Schema.Struct({
      legalEntityId: LegalEntityIdSchema,
      legalName: Schema.String,
    }),
  ),
});

export const DemoAccountListPayloadSchema = Schema.Struct({});
export const DemoAccountCapabilitySchema = Schema.Struct({ canManage: Schema.Boolean });

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

export type CreateNonHumanPrincipalPayload = Schema.Schema.Type<typeof CreateNonHumanPrincipalPayloadSchema>;
export type ChangePrincipalStatusPayload = Schema.Schema.Type<typeof ChangePrincipalStatusPayloadSchema>;
export type IssueApiKeyPayload = Schema.Schema.Type<typeof IssueApiKeyPayloadSchema>;
export type IssueManagedApiKeyPayload = Schema.Schema.Type<typeof IssueManagedApiKeyPayloadSchema>;
export type SetApiKeyStatusPayload = Schema.Schema.Type<typeof SetApiKeyStatusPayloadSchema>;
export type SetManagedApiKeyStatusPayload = Schema.Schema.Type<typeof SetManagedApiKeyStatusPayloadSchema>;
export type RotateApiKeyPayload = Schema.Schema.Type<typeof RotateApiKeyPayloadSchema>;
export type RotateManagedApiKeyPayload = Schema.Schema.Type<typeof RotateManagedApiKeyPayloadSchema>;
export type IdentityListPayload = Schema.Schema.Type<typeof IdentityListPayloadSchema>;
export type ApiKeyLifecycleResponse = Schema.Schema.Type<typeof ApiKeyLifecycleResponseSchema>;
export type ApiKeyIssueResponse = Schema.Schema.Type<typeof ApiKeyIssueResponseSchema>;
export type PrincipalMutationResponse = Schema.Schema.Type<typeof PrincipalMutationResponseSchema>;
export type SelfApiKeyListResponse = Schema.Schema.Type<typeof SelfApiKeyListResponseSchema>;
export type ManagedApiKeyListResponse = Schema.Schema.Type<typeof ManagedApiKeyListResponseSchema>;
export type StartSupportImpersonationPayload = Schema.Schema.Type<typeof StartSupportImpersonationPayloadSchema>;
export type SupportImpersonationResponse = Schema.Schema.Type<typeof SupportImpersonationResponseSchema>;

export type InvalidCredentialsProblem = typeof InvalidCredentialsProblemSchema.Type;
export type OntosIdentityForbiddenProblem = typeof OntosIdentityForbiddenProblemSchema.Type;
export type AuthenticationUnavailableProblem = typeof AuthenticationUnavailableProblemSchema.Type;
export type AuthenticationInternalProblem = typeof AuthenticationInternalProblemSchema.Type;

export type AuthenticationProblem =
  | InvalidCredentialsProblem
  | OntosIdentityForbiddenProblem
  | AuthenticationUnavailableProblem
  | AuthenticationInternalProblem;

export type TenantAuthenticationRequiredProblem = typeof TenantAuthenticationRequiredProblemSchema.Type;
export type TenantAccessForbiddenProblem = typeof TenantAccessForbiddenProblemSchema.Type;
export type TenantCapabilityUnavailableProblem = typeof TenantCapabilityUnavailableProblemSchema.Type;
export type TenantInternalProblem = typeof TenantInternalProblemSchema.Type;

export type AvailableTenantsProblem =
  | TenantAuthenticationRequiredProblem
  | TenantCapabilityUnavailableProblem
  | TenantInternalProblem;

export type SwitchTenantProblem = AvailableTenantsProblem | TenantAccessForbiddenProblem;

export type LegalEntityAccessForbiddenProblem = typeof LegalEntityAccessForbiddenProblemSchema.Type;

export type LegalEntityProblem = AvailableTenantsProblem | LegalEntityAccessForbiddenProblem;

export type ShellAuthenticationRequiredProblem = typeof ShellAuthenticationRequiredProblemSchema.Type;
export type ShellTargetForbiddenProblem = typeof ShellTargetForbiddenProblemSchema.Type;
export type ShellTargetNotFoundProblem = typeof ShellTargetNotFoundProblemSchema.Type;
export type ShellSelectionRequiredProblem = typeof ShellSelectionRequiredProblemSchema.Type;
export type ShellReloadRequiredProblem = typeof ShellReloadRequiredProblemSchema.Type;
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

export const TenantAuthenticatedSessionSchema = Schema.Struct({
  availableLegalEntities: Schema.Array(LegalEntityChoiceSchema),
  identity: SafeTenantIdentitySchema,
  state: Schema.Literal('tenant_authenticated'),
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
  TenantAuthenticatedSessionSchema,
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
  state: Schema.Literals(['access_blocked', 'authenticated', 'selection_required', 'tenant_authenticated']),
  tenantContextAvailable: Schema.Boolean,
});

export const SwitchLegalEntityPayloadSchema = Schema.Struct({
  legalEntityId: LegalEntityIdSchema,
});

export const SwitchToTenantContextResponseSchema = Schema.Struct({
  selectedContext: Schema.Literal('tenant'),
});

export const SwitchLegalEntityResponseSchema = Schema.Struct({
  selectedLegalEntityId: LegalEntityIdSchema,
});

/** Czech and English text declared by the contributing module. */
export const ShellLabelSchema = Schema.Struct({ cs: Schema.String, en: Schema.String });
export type ShellLabel = typeof ShellLabelSchema.Type;

/** Platform capability a destination needs beyond module access; the Shell decides it per person. */
export const ShellNavigationCapabilitySchema = Schema.Literals(['people_administration']);

/** Where a page's code lives: the approved remote container and the exposed module. */
export const ModuleFederationTargetSchema = Schema.Struct({
  expose: Schema.NonEmptyString,
  manifest: Schema.Struct({
    sha256: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
    url: Schema.NonEmptyString,
  }),
  remoteName: Schema.NonEmptyString,
});

export const ShellNavigationItemSchema = Schema.Struct({
  appId: AppIdSchema,
  enabled: Schema.Boolean,
  entrypointKey: EntrypointKeySchema,
  groupKey: GroupKeySchema,
  /** Rank of the destination as the place to begin on Home (lower first); absent when it is no starting point. */
  homeStart: Schema.optional(Schema.Finite.check(Schema.isInt())),
  href: Schema.optionalKey(Schema.String),
  /** Iconify utility class, e.g. `icon-[mdi--home-outline]`. */
  icon: Schema.TemplateLiteral(['icon-[', Schema.String, ']']),
  label: ShellLabelSchema,
  moduleId: ModuleIdSchema,
  order: Schema.Finite.check(Schema.isInt()),
  /** The destination page's code, so the browser can load it while idle without reading anything. */
  remote: Schema.optionalKey(ModuleFederationTargetSchema),
  requiresCapability: Schema.optional(ShellNavigationCapabilitySchema),
  state: Schema.Literals(['active', 'deprecated', 'read_only']),
  unavailable: Schema.Boolean,
  writable: Schema.Boolean,
});

/** A public component a module offers as the Home summary (see the core `home` placement). */
export const ShellHomeComponentSchema = Schema.Struct({
  entrypointKey: EntrypointKeySchema,
  moduleId: ModuleIdSchema,
  order: Schema.Finite.check(Schema.isInt()),
  requiresModules: Schema.Array(ModuleIdSchema),
});
export type ShellHomeComponent = typeof ShellHomeComponentSchema.Type;

export const ShellUnavailableDeploymentSchema = Schema.Union([
  Schema.Struct({
    appId: AppIdSchema,
    status: Schema.Literals(['disabled', 'revoked']),
  }),
  Schema.Struct({
    appId: AppIdSchema,
    reason: Schema.Literals(['incompatible', 'timeout', 'unavailable']),
    status: Schema.Literal('unavailable'),
  }),
]);

export const ShellCompositionSchema = Schema.Union([
  Schema.Struct({
    navigation: Schema.Tuple([]),
    state: Schema.Literal('access_blocked'),
  }),
  Schema.Struct({
    navigation: Schema.Tuple([]),
    state: Schema.Literal('selection_required'),
  }),
  Schema.Struct({
    compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
    /**
     * Deployments whose module access is definitely denied to the principal in the current company. Browser hint
     * only (the gateway skips optional reads of them); every module still authorizes each request itself.
     */
    deniedAppIds: Schema.Array(AppIdSchema),
    /**
     * Module deployments a document of this person may call: every available deployment of the release except the
     * denied ones. The Shell obtains their gateway assertions for the document in one batch.
     */
    gatewayAudiences: Schema.Array(AppIdSchema),
    /** Home summary components of modules the person may open, lowest order first. */
    homeComponents: Schema.Array(ShellHomeComponentSchema),
    navigation: Schema.Array(ShellNavigationItemSchema),
    state: Schema.Literal('available'),
    unavailableDeployments: Schema.Array(ShellUnavailableDeploymentSchema),
  }),
]);

export const ShellCompositionRequestSchema = Schema.Struct({
  compositionRevision: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u))),
});

export const ShellDocumentContextRequestSchema = Schema.Struct({
  ...ShellCompositionRequestSchema.fields,
  /** Only Home documents need their first authorized component resolved. */
  home: Schema.optionalKey(Schema.Literal(true)),
});
export type ShellDocumentContextRequest = typeof ShellDocumentContextRequestSchema.Type;

/** A Shell document's tenant choices; when they cannot be read, only the current tenant is shown. */
export const ShellDocumentTenantsSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal('available'), tenants: Schema.Array(AvailableTenantSchema) }),
  Schema.Struct({ state: Schema.Literals(['authentication_required', 'unavailable']) }),
]);

/** A Shell document's composition, or why the document cannot show one. */
export const ShellDocumentCompositionSchema = Schema.Union([
  ShellCompositionSchema,
  Schema.Struct({ state: Schema.Literals(['reload_required', 'unavailable']) }),
]);

export const ResolveModuleTargetPayloadSchema = Schema.Struct({
  canonicalPath: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40_000))),
  /** The document's pinned release; without it the current release answers and the caller compares its revision. */
  compositionRevision: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u))),
  entrypointKey: Schema.optionalKey(EntrypointKeySchema),
  moduleId: Schema.optionalKey(ModuleIdSchema),
}).check(
  Schema.makeFilter(({ canonicalPath, entrypointKey, moduleId }) =>
    (canonicalPath === undefined) !== (moduleId === undefined) &&
    (canonicalPath === undefined || entrypointKey === undefined)
      ? undefined
      : 'select either a canonical path or a module target',
  ),
);

export const ResolvedModuleTargetSchema = Schema.Struct({
  appId: AppIdSchema,
  componentKey: ComponentKeySchema,
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
  entrypointKey: EntrypointKeySchema,
  federation: ModuleFederationTargetSchema,
  moduleId: ModuleIdSchema,
  routeParameters: Schema.Record(Schema.String, Schema.String),
  writable: Schema.Boolean,
});

export const ShellHomeContributionSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal('ready'), target: ResolvedModuleTargetSchema }),
  Schema.Struct({ state: Schema.Literals(['forbidden', 'unavailable']) }),
]);
export type ShellHomeContribution = typeof ShellHomeContributionSchema.Type;

export const ShellDocumentHomeSchema = Schema.Struct({
  contribution: ShellHomeContributionSchema,
  welcome: Schema.optionalKey(Schema.String),
});
export type ShellDocumentHome = typeof ShellDocumentHomeSchema.Type;

/**
 * One session resolution supplies a document's context and assertions. Home additionally receives its governed
 * component target (or welcome), so hydration can load the remote without another authenticated BFF request.
 * Each part keeps its own outcome. Signed-out or unselected sessions get no Home target or assertions.
 */
export const ShellDocumentContextSchema = Schema.Struct({
  canManagePeople: Schema.optionalKey(Schema.Boolean),
  composition: Schema.optionalKey(ShellDocumentCompositionSchema),
  gatewayAssertions: Schema.optionalKey(Schema.Array(DocumentGatewayAssertionSchema)),
  home: Schema.optionalKey(ShellDocumentHomeSchema),
  legalEntities: Schema.optionalKey(AvailableLegalEntitiesResponseSchema),
  session: CurrentSessionSchema,
  tenants: Schema.optionalKey(ShellDocumentTenantsSchema),
});
export type ShellDocumentContext = typeof ShellDocumentContextSchema.Type;

export const ResourceRefSchema = Schema.Struct({
  moduleId: ModuleIdSchema,
  resourceId: ResourceIdSchema,
  resourceType: Schema.String.check(Schema.isMinLength(3)),
  tenantId: Schema.optionalKey(TenantIdSchema),
});

export const ShellResourceRequestSchema = Schema.Struct({
  ...ResourceRefSchema.fields,
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
});

const searchTitle = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const PartyRoleSchema = Schema.Literals(['CUSTOMER', 'SUPPLIER']);
const ShellSearchResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('resource'),
    ref: ResourceRefSchema,
    title: searchTitle,
  }),
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
  compositionRevision: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/u)),
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

export const InvalidCredentialsProblemSchema = makeProblemDetailsSchema('InvalidCredentialsProblem', 401);

export const OntosIdentityForbiddenProblemSchema = makeProblemDetailsSchema('OntosIdentityForbiddenProblem', 403);

export const AuthenticationUnavailableProblemSchema = makeProblemDetailsSchema('AuthenticationUnavailableProblem', 503);

export const AuthenticationInternalProblemSchema = makeProblemDetailsSchema('AuthenticationInternalProblem', 500);

export const TenantAuthenticationRequiredProblemSchema = makeProblemDetailsSchema(
  'TenantAuthenticationRequiredProblem',
  401,
);

export const TenantAccessForbiddenProblemSchema = makeProblemDetailsSchema('TenantAccessForbiddenProblem', 403);

export const TenantCapabilityUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'TenantCapabilityUnavailableProblem',
  503,
);

export const TenantInternalProblemSchema = makeProblemDetailsSchema('TenantInternalProblem', 500);

export const LegalEntityAccessForbiddenProblemSchema = makeProblemDetailsSchema(
  'LegalEntityAccessForbiddenProblem',
  403,
);

export const ShellAuthenticationRequiredProblemSchema = makeProblemDetailsSchema(
  'ShellAuthenticationRequiredProblem',
  401,
);

export const ShellTargetForbiddenProblemSchema = makeProblemDetailsSchema('ShellTargetForbiddenProblem', 403);

export const ShellTargetNotFoundProblemSchema = makeProblemDetailsSchema('ShellTargetNotFoundProblem', 404);

export const ShellSelectionRequiredProblemSchema = makeProblemDetailsSchema('ShellSelectionRequiredProblem', 409);

export const ShellReloadRequiredProblemSchema = makeProblemDetailsSchema('ShellReloadRequiredProblem', 409);

export const ShellPolicyConflictProblemSchema = makeProblemDetailsSchema('ShellPolicyConflictProblem', 409);

export const ShellPolicyUnprocessableProblemSchema = makeProblemDetailsSchema('ShellPolicyUnprocessableProblem', 422);

export const ShellInvalidRequestProblemSchema = makeProblemDetailsSchema('ShellInvalidRequestProblem', 400);

export const ShellPreconditionRequiredProblemSchema = makeProblemDetailsSchema('ShellPreconditionRequiredProblem', 428);

export const ShellCapabilityUnavailableProblemSchema = makeRetryableProblemDetailsSchema(
  'ShellCapabilityUnavailableProblem',
  503,
);

export const ShellInternalProblemSchema = makeProblemDetailsSchema('ShellInternalProblem', 500);
export const ShellRateLimitedProblemSchema = makeProblemDetailsSchema('ShellRateLimitedProblem', 429, {
  retryAfterSeconds: Schema.Finite,
});

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

/** Agent endpoints authenticate with the agent's API key (Better Auth), like /auth/api-key/gateway-context. */
const AgentApiKeyHeadersSchema = Schema.Struct({
  'x-api-key': Schema.optionalKey(Schema.String),
});
export const AgentOwnProposalsRequestSchema = Schema.Struct({ legalEntityId: Schema.String.check(Schema.isUUID()) });

/**
 * Server rendering's one read per Shell document. It signs the document's gateway assertions too, so it is a classified
 * session capability issuer (`shell.document-context.issue.session` in `gatewayContextAuthorizationEntrypoints`) and,
 * like every issuer, a no-store POST.
 */
export const ShellDocumentContextApiGroup = HttpApiGroup.make('documentContext').add(
  HttpApiEndpoint.post('documentContext', '/shell/document-context', {
    error: [
      InvalidCredentialsProblemSchema,
      OntosIdentityForbiddenProblemSchema,
      AuthenticationUnavailableProblemSchema,
      AuthenticationInternalProblemSchema,
    ],
    payload: ShellDocumentContextRequestSchema,
    success: ShellDocumentContextSchema,
  }),
);

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
        HttpApiEndpoint.post('configureDemoCompanies', '/auth/identity/demo-companies', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: ConfigureDemoCompaniesPayloadSchema,
          success: ConfigureDemoCompaniesResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('demoAccountCapability', '/auth/identity/demo-accounts/capability', {
          error: identityErrors,
          payload: DemoAccountListPayloadSchema,
          success: DemoAccountCapabilitySchema,
        }),
      )
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
            ShellReloadRequiredProblemSchema,
            ShellAuthenticationRequiredProblemSchema,
            ShellTargetForbiddenProblemSchema,
            ShellPolicyConflictProblemSchema,
            ShellPolicyUnprocessableProblemSchema,
            ShellCapabilityUnavailableProblemSchema,
            ShellInternalProblemSchema,
          ],
          query: ShellCompositionRequestSchema,
          success: ShellCompositionSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('resolveModuleTarget', '/shell/module-target', {
          error: [
            ShellReloadRequiredProblemSchema,
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
        HttpApiEndpoint.post('switchToTenantContext', '/auth/context/tenant', {
          error: [
            TenantAuthenticationRequiredProblemSchema,
            TenantAccessForbiddenProblemSchema,
            TenantCapabilityUnavailableProblemSchema,
            TenantInternalProblemSchema,
          ],
          success: SwitchToTenantContextResponseSchema,
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
            ShellReloadRequiredProblemSchema,
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
            ShellReloadRequiredProblemSchema,
            ShellAuthenticationRequiredProblemSchema,
            ShellTargetForbiddenProblemSchema,
            ShellTargetNotFoundProblemSchema,
            ShellPolicyConflictProblemSchema,
            ShellPolicyUnprocessableProblemSchema,
            ShellSelectionRequiredProblemSchema,
            ShellCapabilityUnavailableProblemSchema,
            ShellInternalProblemSchema,
          ],
          payload: ShellResourceRequestSchema,
          success: ShellResourceResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('attachMedia', '/shell/resource/media-attachment', {
          error: [
            ShellReloadRequiredProblemSchema,
            ShellAuthenticationRequiredProblemSchema,
            ShellTargetForbiddenProblemSchema,
            ShellTargetNotFoundProblemSchema,
            ShellPolicyConflictProblemSchema,
            ShellPolicyUnprocessableProblemSchema,
            ShellSelectionRequiredProblemSchema,
            ShellCapabilityUnavailableProblemSchema,
            ShellInternalProblemSchema,
          ],
          payload: ShellResourceRequestSchema,
          success: MediaAttachmentResponseSchema,
        }),
      ),
  )
  // @ontos-codesmith-core-read-api-groups:start

  // @ontos-core-read legal-entity-detail
  .add(
    HttpApiGroup.make('coreReadLegalEntityDetail').add(
      HttpApiEndpoint.post('executeLegalEntityDetail', '/core/reads/legal-entity-detail', {
        error: identityErrors,
        payload: LegalEntityDetailRequestSchema,
        success: LegalEntityDetailResponseSchema,
      }),
    ),
  )
  // @ontos-codesmith-core-read-api-groups:end
  .add(
    HttpApiGroup.make('agentPlatform')
      .add(
        HttpApiEndpoint.post('submitAgentProposals', '/agent-platform/proposals', {
          error: identityErrors,
          headers: AgentApiKeyHeadersSchema,
          payload: AgentProposalSubmitRequestSchema,
          success: AgentProposalSubmitResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('listOwnAgentProposals', '/agent-platform/proposals/list', {
          error: identityErrors,
          headers: AgentApiKeyHeadersSchema,
          payload: AgentOwnProposalsRequestSchema,
          success: AgentQueueResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('agentQueue', '/agent-platform/queue', {
          error: identityErrors,
          payload: AgentQueueRequestSchema,
          success: AgentQueueResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('agentDecide', '/agent-platform/decide', {
          error: identityErrors,
          payload: AgentDecideRequestSchema,
          success: AgentDecideResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('agentRevert', '/agent-platform/revert', {
          error: identityErrors,
          payload: AgentRevertRequestSchema,
          success: AgentRevertResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('agentActivity', '/agent-platform/activity', {
          error: identityErrors,
          payload: AgentActivityRequestSchema,
          success: AgentActivityResponseSchema,
        }),
      ),
  )
  .add(
    HttpApiGroup.make('peopleAdministration')
      .add(
        HttpApiEndpoint.post('invitePerson', PEOPLE_PATHS.companyInvite, {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: InvitePeopleRequestSchema,
          success: InvitePeopleResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('listCompanyPeople', PEOPLE_PATHS.companyList, {
          error: identityErrors,
          payload: PeopleListRequestSchema,
          success: PeopleListResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('listTenantPeople', PEOPLE_PATHS.tenantList, {
          error: identityErrors,
          payload: PeopleListRequestSchema,
          success: PeopleListResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('setPeopleCompanyMembership', PEOPLE_PATHS.companyMembership, {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: SetPeopleCompanyMembershipRequestSchema,
          success: SetPeopleCompanyMembershipResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('setPeopleCompanyRole', PEOPLE_PATHS.companyRole, {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: SetPeopleRoleRequestSchema,
          success: SetPeopleRoleResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('setPeopleTenantRole', PEOPLE_PATHS.tenantRole, {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: SetPeopleRoleRequestSchema,
          success: SetPeopleRoleResponseSchema,
        }),
      ),
  )
  // "Připojené aplikace" and Agentní entity management (paths equal CONNECTION_MANAGEMENT_PATHS and AGENT_ACCESS_PATHS).
  .add(
    HttpApiGroup.make('oauthConnectionsAdmin')
      .add(
        HttpApiEndpoint.post('listMyConnections', '/auth/oauth-connections/mine', {
          error: identityErrors,
          payload: Schema.Struct({}),
          success: ConnectionListResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('listCompanyConnections', '/auth/oauth-connections/admin-list', {
          error: identityErrors,
          payload: ConnectionAdminListRequestSchema,
          success: ConnectionAdminListResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('updateConnectionAccess', '/auth/oauth-connections/update', {
          error: identityErrors,
          payload: ConnectionUpdateRequestSchema,
          success: ConnectionMutationResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('revokeConnection', '/auth/oauth-connections/revoke', {
          error: identityErrors,
          payload: ConnectionRevokeRequestSchema,
          success: ConnectionMutationResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('listAgentEntities', '/auth/identity/agent-entities/list', {
          error: identityErrors,
          payload: Schema.Struct({}),
          success: AgentEntityOverviewSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('manageAgentEntity', '/auth/identity/agent-entities', {
          error: identityErrors,
          headers: IdentityRequestHeadersSchema,
          payload: ManageAgentEntityRequestSchema,
          success: ManageAgentEntityResponseSchema,
        }),
      )
      .add(
        HttpApiEndpoint.post('replaceAgentOperators', '/auth/identity/agent-entities/operators', {
          error: identityErrors,
          payload: AgentOperatorsRequestSchema,
          success: AgentOperatorsResponseSchema,
        }),
      ),
  )
  .add(GatewayContextApiGroup)
  .add(DocumentGatewayApiGroup)
  .add(ShellDocumentContextApiGroup)
  .add(ExternalIdentityApiGroup)
  .add(OAuthConnectApiGroup);

const authenticationEndpointPath = (endpoint: { readonly path: string }) =>
  `/shell-super-app-api${endpoint.path}` as const;

export const shellAuthenticationApiContract = {
  apiPrefix: '/shell-super-app-api',
  signInPath: authenticationEndpointPath(ShellAuthenticationApi.groups.authentication.endpoints.signIn),
  switchTenantPath: authenticationEndpointPath(ShellAuthenticationApi.groups.tenants.endpoints.switchTenant),
  switchToTenantContextPath: authenticationEndpointPath(
    ShellAuthenticationApi.groups.legalEntities.endpoints.switchToTenantContext,
  ),
} as const;
