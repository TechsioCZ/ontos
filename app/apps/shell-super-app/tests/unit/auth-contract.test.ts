import { DECISION_REASON_CODES } from '@app/core-runtime/access/decision/contract';
import { DateTime, Effect, Schema, SchemaAST, Predicate, Struct } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  AuthenticationUnavailableProblemSchema,
  CurrentSessionSchema,
  AvailableLegalEntitiesResponseSchema,
  AvailableTenantsResponseSchema,
  ApiKeyLifecycleResponseSchema,
  ApiKeyListItemSchema,
  ManagedApiKeyListItemSchema,
  ChangePrincipalStatusPayloadSchema,
  IdentityRequestHeadersSchema,
  SignInPayloadSchema,
  ResolveModuleTargetPayloadSchema,
  ShellAuthenticationApi,
  SwitchTenantPayloadSchema,
  SwitchTenantResponseSchema,
  SwitchLegalEntityPayloadSchema,
  SetApiKeyStatusPayloadSchema,
  ShellRateLimitedProblemSchema,
  TenantCapabilityUnavailableProblemSchema,
  shellAuthenticationApiContract,
} from '../../shared/api.ts';
import {
  AccessDecisionReasonCodeSchema,
  DecideAccessChangesPayloadSchema,
  PreviewAccessChangesPayloadSchema,
} from '../../shared/access-admin-api.ts';
import { LegalEntityDetailResponseSchema } from '../../shared/core-reads/legal-entity-detail.ts';

type TenantEndpoint =
  | typeof ShellAuthenticationApi.groups.tenants.endpoints.availableTenants
  | typeof ShellAuthenticationApi.groups.tenants.endpoints.switchTenant;

const statuses = (endpoint: TenantEndpoint) =>
  [...endpoint.error]
    .map((schema) => Schema.resolveAnnotationsKey(schema)?.httpApiStatus)
    .toSorted((left, right) => Number(left) - Number(right));

const problemTag = (schema: Schema.Top): SchemaAST.LiteralValue => {
  expect(SchemaAST.isObjects(schema.ast)).toBe(true);
  if (!SchemaAST.isObjects(schema.ast)) {
    throw new Error('Expected an object problem schema');
  }
  const tag = schema.ast.propertySignatures.find(({ name }) => name === '_tag')?.type;
  expect(tag !== undefined && SchemaAST.isLiteral(tag)).toBe(true);
  if (tag === undefined || !SchemaAST.isLiteral(tag)) {
    throw new Error('Expected a literal problem tag');
  }
  return tag.literal;
};

it('publishes authentication, identity lifecycle, and gateway operations', () => {
  const authenticationEndpoints = Object.keys(ShellAuthenticationApi.groups.authentication.endpoints).toSorted();
  const gatewayEndpoints = Object.keys(ShellAuthenticationApi.groups.gatewayContext.endpoints);
  const identityEndpoints = Object.keys(ShellAuthenticationApi.groups.identity.endpoints).toSorted();
  const legalEntityEndpoints = Object.keys(ShellAuthenticationApi.groups.legalEntities.endpoints).toSorted();
  const tenantEndpoints = Object.keys(ShellAuthenticationApi.groups.tenants.endpoints).toSorted();
  const resourceEndpoints = Object.keys(ShellAuthenticationApi.groups.resources.endpoints).toSorted();
  const externalIdentityEndpoints = Object.keys(ShellAuthenticationApi.groups.externalIdentity.endpoints).toSorted();
  const agentPlatformEndpoints = Object.keys(ShellAuthenticationApi.groups.agentPlatform.endpoints).toSorted();

  expect(agentPlatformEndpoints).toEqual([
    'agentActivity',
    'agentDecide',
    'agentQueue',
    'agentRevert',
    'listOwnAgentProposals',
    'submitAgentProposals',
  ]);
  expect(authenticationEndpoints).toEqual(['currentSession', 'signIn', 'signOut']);
  expect(gatewayEndpoints).toEqual([
    'issueGatewayContext',
    'issueApiKeyGatewayContext',
    'readWithApiKeyGatewayContext',
    'issueDelegatedGatewayContext',
  ]);
  expect(Object.keys(ShellAuthenticationApi.groups.documentGateway.endpoints)).toEqual([
    'issueDocumentGatewayContexts',
  ]);
  expect(Object.keys(ShellAuthenticationApi.groups.emailReceipts.endpoints)).toEqual(['list', 'provider']);
  expect(identityEndpoints).toEqual([
    'changePrincipalStatus',
    'configureDemoCompanies',
    'createNonHumanPrincipal',
    'demoAccountCapability',
    'issueManagedApiKey',
    'issueSelfApiKey',
    'listManagedApiKeys',
    'listSelfApiKeys',
    'rotateManagedApiKey',
    'rotateSelfApiKey',
    'setManagedApiKeyStatus',
    'setSelfApiKeyStatus',
    'startSupportImpersonation',
    'stopSupportImpersonation',
  ]);
  expect(legalEntityEndpoints).toEqual(['availableLegalEntities', 'switchLegalEntity', 'switchToTenantContext']);
  expect(tenantEndpoints).toEqual(['availableTenants', 'switchTenant']);
  expect(resourceEndpoints).toEqual(['attachMedia', 'resourceDetail', 'search']);
  expect(externalIdentityEndpoints).toEqual([
    'activatePrincipalBinding',
    'changePrincipalBindingStatus',
    'issueExternalGatewayContext',
    'readPrincipalBinding',
    'reservePrincipalBinding',
    'resolveExternalSubject',
  ]);
  expect(
    Object.fromEntries(
      Object.values(ShellAuthenticationApi.groups).flatMap((group) =>
        Object.entries(group.endpoints).map(([name, endpoint]) => [name, endpoint.path]),
      ),
    ),
  ).toEqual({
    activatePrincipalBinding: '/auth/identity/external/bindings/activate',
    agentActivity: '/agent-platform/activity',
    agentDecide: '/agent-platform/decide',
    agentQueue: '/agent-platform/queue',
    agentRevert: '/agent-platform/revert',
    assignAccessRole: '/shell/access/people/assign',
    attachMedia: '/shell/resource/media-attachment',
    availableLegalEntities: '/auth/legal-entities',
    availableTenants: '/auth/tenants',
    changePrincipalBindingStatus: '/auth/identity/external/binding/status',
    changePrincipalStatus: '/auth/identity/principal-status',
    configureDemoCompanies: '/auth/identity/demo-companies',
    connectApprove: '/auth/oauth-connections/approve',
    connectDeny: '/auth/oauth-connections/deny',
    connectDraft: '/auth/oauth-connections/draft',
    connectDraftSummary: '/auth/oauth-connections/draft-summary',
    connectOptions: '/auth/oauth-connections/options',
    createAccessDelegation: '/shell/access/people/delegate',
    createAccessRole: '/shell/access/roles/create',
    createNonHumanPrincipal: '/auth/identity/principals',
    currentSession: '/auth/session',
    decideAccessApproval: '/shell/access/approvals/decide',
    decideAccessChanges: '/shell/access/changes/decide',
    demoAccountCapability: '/auth/identity/demo-accounts/capability',
    documentContext: '/shell/document-context',
    executeAccessApproval: '/shell/access/approvals/execute',
    executeLegalEntityDetail: '/core/reads/legal-entity-detail',
    explainAccess: '/shell/access/explain',
    getAccessRole: '/shell/access/roles/detail',
    invitePerson: '/auth/identity/people/invite',
    issueApiKeyGatewayContext: '/auth/api-key/gateway-context',
    issueDelegatedGatewayContext: '/auth/delegated/gateway-context',
    issueDocumentGatewayContexts: '/auth/gateway-contexts',
    issueExternalGatewayContext: '/auth/identity/external/gateway-context',
    issueGatewayContext: '/auth/gateway-context',
    issueManagedApiKey: '/auth/identity/api-keys/managed',
    issueSelfApiKey: '/auth/identity/api-keys/self',
    list: '/email/deliveries',
    listAccessApprovals: '/shell/access/approvals/list',
    listAccessAssignments: '/shell/access/people/assignments',
    listAccessChanges: '/shell/access/changes/list',
    listAccessPeople: '/shell/access/people/list',
    listAccessPeopleOptions: '/shell/access/people/options',
    listAccessRoles: '/shell/access/roles/list',
    listAccessRoleTemplates: '/shell/access/roles/templates',
    listAgentEntities: '/auth/identity/agent-entities/list',
    listCompanyConnections: '/auth/oauth-connections/admin-list',
    listCompanyPeople: '/auth/identity/people/list',
    listManagedApiKeys: '/auth/identity/api-keys/managed/list',
    listMyConnections: '/auth/oauth-connections/mine',
    listOwnAgentProposals: '/agent-platform/proposals/list',
    listSelfApiKeys: '/auth/identity/api-keys/self/list',
    listTenantPeople: '/auth/identity/people/tenant-list',
    manageAgentEntity: '/auth/identity/agent-entities',
    previewAccessChanges: '/shell/access/changes/preview',
    previewAccessRoleEdit: '/shell/access/roles/preview',
    provider: '/email/provider',
    readPrincipalBinding: '/auth/identity/external/bindings/read',
    readWithApiKeyGatewayContext: '/auth/api-key/gateway-read',
    replaceAgentOperators: '/auth/identity/agent-entities/operators',
    requestPeopleSearchRebuild: '/core.identity/actions/request-people-search-rebuild',
    reservePrincipalBinding: '/auth/identity/external/bindings/reserve',
    resolveExternalSubject: '/auth/identity/external/resolve',
    resolveModuleTarget: '/shell/module-target',
    resolveModuleTargets: '/shell/module-targets',
    resourceDetail: '/shell/resource',
    revokeAccessAssignment: '/shell/access/people/revoke-assignment',
    revokeAccessDelegation: '/shell/access/people/revoke-delegation',
    revokeConnection: '/auth/oauth-connections/revoke',
    rotateManagedApiKey: '/auth/identity/api-keys/managed/rotate',
    rotateSelfApiKey: '/auth/identity/api-keys/self/rotate',
    saveAccessRoleEdit: '/shell/access/roles/save',
    search: '/shell/search',
    setAccessTeamMembership: '/shell/access/people/team-membership',
    setManagedApiKeyStatus: '/auth/identity/api-keys/managed/status',
    setPeopleCompanyMembership: '/auth/identity/people/company-membership',
    setSelfApiKeyStatus: '/auth/identity/api-keys/self/status',
    shellComposition: '/shell/composition',
    signIn: '/auth/sign-in',
    signOut: '/auth/sign-out',
    startSupportImpersonation: '/auth/identity/impersonation/start',
    stopSupportImpersonation: '/auth/identity/impersonation/stop',
    submitAgentProposals: '/agent-platform/proposals',
    switchLegalEntity: '/auth/legal-entity/switch',
    switchTenant: '/auth/tenant/switch',
    switchToTenantContext: '/auth/context/tenant',
    transferAccessOwnership: '/shell/access/people/transfer-ownership',
    updateConnectionAccess: '/auth/oauth-connections/update',
  });
  expect(shellAuthenticationApiContract).toEqual({
    apiPrefix: '/shell-super-app-api',
    signInPath: '/shell-super-app-api/auth/sign-in',
    switchTenantPath: '/shell-super-app-api/auth/tenant/switch',
    switchToTenantContextPath: '/shell-super-app-api/auth/context/tenant',
  });
  expect([...authenticationEndpoints, ...gatewayEndpoints].join(':')).not.toMatch(/testing|actionKey/u);
});

it('requires an explicit tenant or company target for every Novinky preview and decision', () => {
  const base = {
    catalogSnapshotId: '11111111-1111-4111-8111-111111111111',
    decision: 'adopt',
    itemIds: ['22222222-2222-4222-8222-222222222222'],
  };
  expect(Schema.is(PreviewAccessChangesPayloadSchema)(base)).toBe(false);
  expect(Schema.is(PreviewAccessChangesPayloadSchema)({ ...base, legalEntityId: null })).toBe(true);
  expect(
    Schema.is(PreviewAccessChangesPayloadSchema)({
      ...base,
      legalEntityId: '33333333-3333-4333-8333-333333333333',
    }),
  ).toBe(true);
  expect(Schema.is(DecideAccessChangesPayloadSchema)({ ...base, decision: 'decline' })).toBe(false);
  expect(Schema.is(DecideAccessChangesPayloadSchema)({ ...base, decision: 'decline', legalEntityId: null })).toBe(true);
});

it('recognizes every Core decision reason without inventing a browser-only code', () => {
  for (const code of DECISION_REASON_CODES) {
    expect(Schema.is(AccessDecisionReasonCodeSchema)(code)).toBe(true);
  }
  expect(Schema.is(AccessDecisionReasonCodeSchema)('allow.unpublished')).toBe(false);
});

it('omits ungranted identity fields without weakening API-key mutation responses', () => {
  expect(Schema.decodeUnknownSync(ApiKeyListItemSchema)({})).toEqual({});
  expect(
    Schema.decodeUnknownSync(ManagedApiKeyListItemSchema)({
      key: null,
      kind: 'service',
      principalId: '11111111-1111-4111-8111-111111111111',
      principalStatus: 'active',
    }),
  ).not.toHaveProperty('displayName');
  expect(
    Schema.decodeUnknownSync(LegalEntityDetailResponseSchema)({
      legalEntityRef: {
        moduleId: 'core.identity',
        resourceId: '11111111-1111-4111-8111-111111111111',
        resourceType: 'core.identity.legal-entity',
        tenantId: '22222222-2222-4222-8222-222222222222',
      },
      status: 'active',
    }),
  ).not.toHaveProperty('legalName');
  expect(() => Schema.decodeUnknownSync(ApiKeyLifecycleResponseSchema)({})).toThrow();
});

it('preserves migrated Shell Problem Details wire shapes and ordered membership', () => {
  const unavailable = {
    _tag: 'AuthenticationUnavailableProblem',
    detail: 'Authentication is temporarily unavailable. Please retry.',
    status: 503,
    title: 'Authentication unavailable',
    type: 'https://ontos.dev/problems/authentication-unavailable',
  } as const;
  const retryable = {
    _tag: 'TenantCapabilityUnavailableProblem',
    detail: 'Tenant capability is temporarily unavailable.',
    retryable: true,
    status: 503,
    title: 'Tenant capability unavailable',
    type: 'https://ontos.dev/problems/tenant-capability-unavailable',
  } as const;
  const rateLimited = {
    _tag: 'ShellRateLimitedProblem',
    detail: 'Retry after the published delay.',
    retryAfterSeconds: 15,
    status: 429,
    title: 'Rate limited',
    type: 'https://ontos.dev/problems/shell-rate-limited',
  } as const;
  const decodedUnavailable = Schema.decodeUnknownSync(AuthenticationUnavailableProblemSchema)(unavailable);
  expect(Schema.is(AuthenticationUnavailableProblemSchema)(decodedUnavailable)).toBe(true);
  expect(Struct.omit(decodedUnavailable, ['_tag'])).toEqual(Struct.omit(unavailable, ['_tag']));
  const decodedRetryable = Schema.decodeUnknownSync(TenantCapabilityUnavailableProblemSchema)(retryable);
  expect(Schema.is(TenantCapabilityUnavailableProblemSchema)(decodedRetryable)).toBe(true);
  expect(Struct.omit(decodedRetryable, ['_tag'])).toEqual(Struct.omit(retryable, ['_tag']));
  const decodedRateLimited = Schema.decodeUnknownSync(ShellRateLimitedProblemSchema)(rateLimited);
  expect(Schema.is(ShellRateLimitedProblemSchema)(decodedRateLimited)).toBe(true);
  expect(Struct.omit(decodedRateLimited, ['_tag'])).toEqual(Struct.omit(rateLimited, ['_tag']));
  expect(() =>
    Schema.decodeUnknownSync(AuthenticationUnavailableProblemSchema, {
      onExcessProperty: 'error',
    })({ ...unavailable, retryable: true }),
  ).toThrow();
  expect([...ShellAuthenticationApi.groups.authentication.endpoints.signIn.error].map(problemTag)).toEqual([
    'InvalidCredentialsProblem',
    'OntosIdentityForbiddenProblem',
    'AuthenticationUnavailableProblem',
    'AuthenticationInternalProblem',
  ]);
});

it.effect('decodes a missing identity idempotency header so handlers can return declared 428', () =>
  Effect.gen(function* testProgram1() {
    expect(yield* Schema.decodeUnknownEffect(IdentityRequestHeadersSchema)({})).toEqual({});
    expect(
      yield* Effect.flip(
        Schema.decodeUnknownEffect(IdentityRequestHeadersSchema)({
          'idempotency-key': '',
        }),
      ),
    ).toBeDefined();
  }),
);

it.effect('publishes exact legal-entity endpoints with an ID-only switch payload', () =>
  Effect.gen(function* testProgram2() {
    const { availableLegalEntities, switchLegalEntity, switchToTenantContext } =
      ShellAuthenticationApi.groups.legalEntities.endpoints;
    expect({ method: switchToTenantContext.method, path: switchToTenantContext.path }).toEqual({
      method: 'POST',
      path: '/auth/context/tenant',
    });
    expect({
      method: availableLegalEntities.method,
      path: availableLegalEntities.path,
    }).toEqual({
      method: 'GET',
      path: '/auth/legal-entities',
    });
    expect({
      method: switchLegalEntity.method,
      path: switchLegalEntity.path,
    }).toEqual({
      method: 'POST',
      path: '/auth/legal-entity/switch',
    });
    const legalEntityId = '35000000-0000-4000-8000-000000000001';
    expect(
      yield* Schema.decodeUnknownEffect(SwitchLegalEntityPayloadSchema)({
        authorization: 'must-not-pass',
        legalEntityId,
        tenantId: 'must-not-pass',
      }),
    ).toEqual({ legalEntityId });
    expect(
      yield* Schema.decodeUnknownEffect(AvailableLegalEntitiesResponseSchema)({
        legalEntities: [{ legalEntityId, legalName: 'Alpha', token: 'must-not-pass' }],
        selectedLegalEntityId: legalEntityId,
        state: 'authenticated',
        tenantContextAvailable: false,
      }),
    ).toEqual({
      legalEntities: [{ legalEntityId, legalName: 'Alpha' }],
      selectedLegalEntityId: legalEntityId,
      state: 'authenticated',
      tenantContextAvailable: false,
    });
  }),
);

it.effect('decodes an optional exact page entrypoint without accepting private routing fields', () =>
  Effect.gen(function* testProgram3() {
    const compositionRevision = 'a'.repeat(64);
    expect(
      yield* Schema.decodeUnknownEffect(ResolveModuleTargetPayloadSchema)({
        compositionRevision,
        entrypointKey: 'contacts.core.page.customers',
        importPath: 'must-not-pass',
        moduleId: 'contacts.core',
        routePath: '/contacts/customers',
      }),
    ).toEqual({
      compositionRevision,
      entrypointKey: 'contacts.core.page.customers',
      moduleId: 'contacts.core',
    });
    expect(
      yield* Schema.decodeUnknownEffect(ResolveModuleTargetPayloadSchema)({
        compositionRevision,
        moduleId: 'contacts.core',
      }),
    ).toEqual({ compositionRevision, moduleId: 'contacts.core' });
    expect(
      yield* Effect.flip(
        Schema.decodeUnknownEffect(ResolveModuleTargetPayloadSchema)({
          compositionRevision,
          entrypointKey: '../private-page',
          moduleId: 'contacts.core',
        }),
      ),
    ).toBeDefined();
  }),
);

it('publishes exact tenant methods, paths, and declared failure statuses', () => {
  const { availableTenants, switchTenant } = ShellAuthenticationApi.groups.tenants.endpoints;
  expect({
    method: availableTenants.method,
    path: availableTenants.path,
  }).toEqual({
    method: 'GET',
    path: '/auth/tenants',
  });
  expect({ method: switchTenant.method, path: switchTenant.path }).toEqual({
    method: 'POST',
    path: '/auth/tenant/switch',
  });
  expect(statuses(availableTenants)).toEqual([401, 500, 503]);
  expect(statuses(switchTenant)).toEqual([401, 403, 500, 503]);
});

it('publishes the exhaustive identity failure status contract', () => {
  for (const endpoint of Object.values(ShellAuthenticationApi.groups.identity.endpoints)) {
    const identityStatuses = [...endpoint.error]
      .map((schema) => Schema.resolveAnnotationsKey(schema)?.httpApiStatus)
      .toSorted((left, right) => Number(left) - Number(right));

    expect(identityStatuses).toEqual([400, 401, 403, 404, 409, 422, 428, 429, 500, 503]);
  }
});

it.effect('validates tenant UUIDs and strips all non-contract fields', () =>
  Effect.gen(function* testProgram4() {
    const tenantId = '30000000-0000-4000-8000-000000000001';
    expect(
      yield* Schema.decodeUnknownEffect(AvailableTenantsResponseSchema)({
        tenants: [
          {
            bindingId: 'must-not-pass',
            name: 'Alpha tenant',
            principalId: 'must-not-pass',
            sessionId: 'must-not-pass',
            tenantId,
            token: 'must-not-pass',
          },
        ],
      }),
    ).toEqual({ tenants: [{ name: 'Alpha tenant', tenantId }] });
    expect(
      yield* Schema.decodeUnknownEffect(SwitchTenantResponseSchema)({
        principalId: 'must-not-pass',
        selectedTenantId: tenantId,
        sessionId: 'must-not-pass',
      }),
    ).toEqual({ selectedTenantId: tenantId });
    expect(yield* Schema.decodeUnknownEffect(SwitchTenantPayloadSchema)({ tenantId })).toEqual({
      tenantId,
    });
    const invalidPayload = yield* Effect.flip(
      Schema.decodeUnknownEffect(SwitchTenantPayloadSchema)({
        tenantId: 'not-a-uuid',
      }),
    );
    expect(Predicate.isTagged(invalidPayload, 'SchemaError')).toBe(true);
  }),
);

it.effect('rejects malformed credentials through Effect Schema', () =>
  Effect.gen(function* testProgram5() {
    const error = yield* Effect.flip(
      Schema.decodeUnknownEffect(SignInPayloadSchema)({
        email: '',
        password: '',
      }),
    );
    expect(Predicate.isTagged(error, 'SchemaError')).toBe(true);
  }),
);

it.effect('requires lifecycle reasons and strips provider-private API key identifiers', () =>
  Effect.gen(function* testProgram6() {
    const principalId = '00000000-0000-4000-8000-000000000001';
    const authBindingId = '00000000-0000-4000-8000-000000000002';
    const createdAt = '2026-08-09T00:00:00.000Z';
    const missingPrincipalReason = yield* Effect.flip(
      Schema.decodeUnknownEffect(ChangePrincipalStatusPayloadSchema)({
        expectedStatus: 'active',
        newStatus: 'disabled',
        principalId,
      }),
    );
    const missingRevocationReason = yield* Effect.flip(
      Schema.decodeUnknownEffect(SetApiKeyStatusPayloadSchema)({
        authBindingId,
        expectedStatus: 'active',
        newStatus: 'revoked',
      }),
    );
    expect(Predicate.isTagged(missingPrincipalReason, 'SchemaError')).toBe(true);
    expect(Predicate.isTagged(missingRevocationReason, 'SchemaError')).toBe(true);

    const lifecycle = yield* Schema.decodeUnknownEffect(ApiKeyLifecycleResponseSchema)({
      authBindingId,
      cleanupPending: false,
      createdAt,
      enabled: true,
      expiresAt: null,
      id: 'private-provider-key-id',
      name: null,
      providerKeyId: 'private-provider-key-id',
      start: 'onto',
    });
    expect(lifecycle).toEqual({
      authBindingId,
      cleanupPending: false,
      createdAt: DateTime.makeUnsafe(createdAt),
      enabled: true,
      expiresAt: null,
      name: null,
      start: 'onto',
    });
    expect(yield* Schema.encodeEffect(ApiKeyLifecycleResponseSchema)(lifecycle)).toEqual({
      authBindingId,
      cleanupPending: false,
      createdAt,
      enabled: true,
      expiresAt: null,
      name: null,
      start: 'onto',
    });
  }),
);

it.effect('decodes only safe current-session identity fields', () =>
  Effect.gen(function* testProgram7() {
    const session = yield* Schema.decodeUnknownEffect(CurrentSessionSchema)({
      identity: {
        displayName: 'Ada',
        email: 'ada@example.test',
        legalEntityId: '35000000-0000-4000-8000-000000000001',
        legalName: 'Alpha legal entity',
        password: 'must-not-pass',
        principalId: 'principal-id',
        tenantId: 'tenant-id',
        token: 'must-not-pass',
      },
      state: 'authenticated',
    });
    expect(session).toEqual({
      identity: {
        displayName: 'Ada',
        email: 'ada@example.test',
        legalEntityId: '35000000-0000-4000-8000-000000000001',
        legalName: 'Alpha legal entity',
        principalId: 'principal-id',
        tenantId: 'tenant-id',
      },
      state: 'authenticated',
    });
  }),
);
