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

export interface ShellCapabilityUnavailableProblem extends ProblemDetails {
  readonly _tag: 'ShellCapabilityUnavailableProblem';
  readonly retryable: true;
}

export interface ShellInternalProblem extends ProblemDetails {
  readonly _tag: 'ShellInternalProblem';
}

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

export const ShellCapabilityUnavailableProblemSchema = Schema.TaggedStruct(
  'ShellCapabilityUnavailableProblem',
  { ...authenticationProblemFields, retryable: Schema.Literal(true) },
).pipe(asProblemDetails, HttpApiSchema.status(503));

export const ShellInternalProblemSchema = Schema.TaggedStruct(
  'ShellInternalProblem',
  authenticationProblemFields,
).pipe(asProblemDetails, HttpApiSchema.status(500));

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
  compositionPath: '/shell-super-app-api/shell/composition',
  currentSessionPath: '/shell-super-app-api/auth/session',
  issueGatewayContextPath: '/shell-super-app-api/auth/gateway-context',
  mediaAttachmentPath: '/shell-super-app-api/shell/resource/media-attachment',
  ownerId: 'shell-super-app',
  resolveModuleTargetPath: '/shell-super-app-api/shell/module-target',
  resourceDetailPath: '/shell-super-app-api/shell/resource',
  searchPath: '/shell-super-app-api/shell/search',
  signInPath: '/shell-super-app-api/auth/sign-in',
  signOutPath: '/shell-super-app-api/auth/sign-out',
  switchLegalEntityPath: '/shell-super-app-api/auth/legal-entity/switch',
  switchTenantPath: '/shell-super-app-api/auth/tenant/switch',
} as const;
