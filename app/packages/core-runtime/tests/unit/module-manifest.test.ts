import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';

import { defineAction } from '../../src/actions/definition.ts';
import {
  ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  decodeOntosModuleDeploymentContract,
  defineOntosModuleManifest,
  validateOntosModuleExecutableReferences,
  validateOntosModuleManifestFields,
} from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { OntosShellContributionsSchema } from '../../src/modules/shell-contribution.ts';
import {
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
  getVerticalRuntimeActions,
  getVerticalRuntimeEntrypoints,
} from '../../src/modules/runtime-registration.ts';

const componentValue = () => null;
const UnitId = Schema.String.pipe(Schema.brand('UnitId'));

const createAction = (owner = 'property.registry') =>
  defineAction(
    {
      accessEvidencePolicy: {
        captureMode: 'metadata_only',
        policyKey: `${owner}.read.v1`,
      },
      actionKey: `${owner}.create-unit`,
      auditProfile: 'standard',
      domainErrorSchema: Schema.Never,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: {
          kind: 'action_execution',
          provisioning: 'tenant_membership_default',
        },
        entrypointKey: `${owner}.create-unit`,
        moduleKey: owner,
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: owner,
      payloadSchema: Schema.Struct({ name: Schema.String }),
      policies: [],
      resultSchema: Schema.Struct({ id: Schema.String }),
      schemaVersion: '1',
    },
    ({ name }) => Effect.succeed({ id: name }),
  );

const emptyManifestInput = () => ({
  activation: {
    defaultState: 'inactive' as const,
    preservesHistoryWhenInactive: true,
    scope: 'tenant' as const,
    supportedStates: ['inactive', 'active', 'read_only', 'suspended', 'quarantined', 'deprecated', 'archived'] as const,
  },
  module: {
    description: 'Property capability',
    displayName: 'Property Registry',
    id: 'property.registry' as const,
    implementedAs: 'ultramodern_microvertical' as const,
    kind: 'business_module' as const,
  },
  publicSurface: {
    actions: [] as const,
    api: {},
    components: {},
    events: [] as const,
    reports: [] as const,
    resourceTypes: [] as const,
    search: [] as const,
    shellContributions: {
      mediaAttachments: [] as const,
      navigation: [] as const,
      pages: [] as const,
      publicComponents: [] as const,
      reports: [] as const,
      resourceDetails: [] as const,
      search: [] as const,
      timelines: [] as const,
    },
  },
});

it('defines a valid empty manifest, preserves literals, and freezes its public shape', () => {
  const manifest = defineOntosModuleManifest(emptyManifestInput());
  const literal: 'property.registry' = manifest.module.id;

  expect(literal).toBe('property.registry');
  expect(Object.keys(manifest)).toEqual(['activation', 'module', 'publicSurface']);
  expect(Object.isFrozen(manifest)).toBe(true);
  expect(Object.isFrozen(manifest.activation.supportedStates)).toBe(true);
  expect(Object.isFrozen(manifest.publicSurface.actions)).toBe(true);
  expect(() =>
    Object.defineProperty(manifest.publicSurface.actions, 0, {
      value: 'private',
    }),
  ).toThrow();
});

it.effect('accepts populated typed surfaces and keeps executable values out of safe descriptors', () =>
  Effect.gen(function* verifySafeDescriptors() {
    const action = createAction();
    const apiValue = HttpApi.make('PropertyApi').add(
      HttpApiGroup.make('property').add(HttpApiEndpoint.get('listUnits', '/units')),
    );
    const parameterizedApiValue = HttpApi.make('PropertyDetailApi').add(
      HttpApiGroup.make('propertyDetail').add(
        HttpApiEndpoint.get('getUnit', '/units/:unitId', {
          params: { unitId: UnitId },
        }),
      ),
    );
    const manifest = defineOntosModuleManifest({
      ...emptyManifestInput(),
      publicSurface: {
        actions: [action],
        api: {
          PropertyClient: apiValue,
          PropertyDetail: parameterizedApiValue,
        },
        components: { PropertyUnitCard: componentValue },
        events: [
          {
            key: 'property.unit-created',
            owningModuleId: 'property.registry',
            payloadSchema: Schema.Struct({ unitId: UnitId }),
            referencesResourceTypes: ['property.unit'],
            tense: 'past',
            visibility: 'public_module_event',
          },
        ],
        reports: [
          {
            accessFiltering: 'legal_entity_scope',
            dimensions: ['legal_entity'],
            key: 'property.unit-inventory',
            label: 'Unit inventory',
            owningModuleId: 'property.registry',
            resourceTypes: ['property.unit'],
          },
        ],
        resourceTypes: [
          {
            capabilities: {
              graphVisible: true,
              linkable: true,
              mediaAttachable: true,
              searchable: true,
              timelineVisible: true,
            },
            description: 'A physical unit',
            key: 'property.unit',
            label: 'Unit',
            owningModuleId: 'property.registry',
          },
        ],
        search: [
          {
            accessFiltering: 'legal_entity_scope',
            key: 'property.unit-search',
            owningModuleId: 'property.registry',
            resourceType: 'property.unit',
          },
        ],
        shellContributions: emptyManifestInput().publicSurface.shellContributions,
      },
    });
    const registration = defineVerticalRuntimeRegistration({
      actions: [action],
      entrypoints: {
        api: { resource: () => Promise.resolve(apiValue) },
        components: {
          dashboard: () => Promise.resolve(componentValue),
        },
        pages: {},
        reports: {},
        search: {},
      },
      manifest,
      outboxWorkers: [],
    });
    const descriptors = extractVerticalRuntimeSafeDescriptors(registration);

    expect(manifest.publicSurface.actions[0]).toBe(action);
    expect(manifest.publicSurface.api.PropertyClient).toBe(apiValue);
    expect(manifest.publicSurface.api.PropertyDetail).toBe(parameterizedApiValue);
    expect(manifest.publicSurface.components.PropertyUnitCard).toBe(componentValue);
    expect(Object.keys(registration)).toEqual(['moduleId']);
    expect(getVerticalRuntimeActions(registration)[0]).toBe(action);
    const loadDashboard = getVerticalRuntimeEntrypoints(registration).components['dashboard'];
    expect(loadDashboard).toBeDefined();
    if (loadDashboard === undefined) {
      throw new Error('Expected assertion to hold');
    }
    expect(yield* Effect.promise(loadDashboard)).toBe(componentValue);
    expect(descriptors).toEqual({
      actions: [
        {
          actionKey: 'property.registry.create-unit',
          auditProfile: 'standard',
          entrypoint: action.descriptor.entrypoint,
          idempotency: 'required',
          legalEntityScope: 'optional',
          owningModuleId: 'property.registry',
          schemaVersion: '1',
        },
      ],
      moduleId: 'property.registry',
      outboxSubscriptions: [],
      shellContributions: emptyManifestInput().publicSurface.shellContributions,
    });
  }),
);

it('rejects invalid identities, private fields, duplicates, cross-owner values, and undeclared references', () => {
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      module: { ...emptyManifestInput().module, id: 'property-registry' },
    }),
  ).toThrow();
  const privateRoutesInput = {
    ...emptyManifestInput(),
    privateRoutes: [],
  };
  expect(() => validateOntosModuleManifestFields(privateRoutesInput, privateRoutesInput.publicSurface)).toThrow();
  const dependenciesInput = {
    ...emptyManifestInput(),
    dependencies: { core: [], externalSystems: [], modules: [] },
  };
  expect(() => validateOntosModuleManifestFields(dependenciesInput, dependenciesInput.publicSurface)).toThrow();
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      activation: {
        ...emptyManifestInput().activation,
        supportedStates: ['inactive', 'inactive'],
      },
    }),
  ).toThrow();
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      publicSurface: {
        ...emptyManifestInput().publicSurface,
        actions: [createAction('billing.invoice')],
      },
    }),
  ).toThrow();
  expect(() =>
    defineOntosModuleManifest({
      ...emptyManifestInput(),
      publicSurface: {
        ...emptyManifestInput().publicSurface,
        search: [
          {
            accessFiltering: 'tenant_scope',
            key: 'property.unit-search',
            owningModuleId: 'property.registry',
            resourceType: 'property.missing',
          },
        ],
      },
    }),
  ).toThrow();
  expect(() =>
    validateOntosModuleExecutableReferences(
      [
        {
          descriptor: {
            actionKey: 'property.registry.fake',
            auditProfile: 'minimal',
            idempotency: 'optional',
            legalEntityScope: 'optional',
            owningModuleKey: 'property.registry',
            schemaVersion: '1',
          },
        },
      ],
      [],
      [],
      [],
      'property.registry',
    ),
  ).toThrow(/real values created by defineAction/u);
  expect(() => validateOntosModuleExecutableReferences([], [42], [], [], 'property.registry')).toThrow(
    /real Effect HttpApi/u,
  );
  expect(() => validateOntosModuleExecutableReferences([], [], ['not-a-component'], [], 'property.registry')).toThrow(
    /callable component/u,
  );
  expect(() => validateOntosModuleExecutableReferences([], [], [], [{}], 'property.registry')).toThrow(
    /Effect Schema value/u,
  );
});

it('deployment contract decoding is exact and versioned', () => {
  const contract = {
    deployment: { appId: 'property-registry', buildMarker: 'build-1' },
    manifest: {
      ...emptyManifestInput(),
      publicSurface: {
        actions: [],
        api: [],
        components: [],
        events: [],
        reports: [],
        resourceTypes: [],
        search: [],
        shellContributions: emptyManifestInput().publicSurface.shellContributions,
      },
    },
    runtime: { outboxSubscriptions: [] },
    schemaVersion: ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  };

  expect(decodeOntosModuleDeploymentContract(contract)).toEqual(contract);
  expect(contract.schemaVersion).toBe('2');
  expect(() =>
    decodeOntosModuleDeploymentContract({
      ...contract,
      sourcePath: './private.ts',
    }),
  ).toThrow();
  expect(() =>
    decodeOntosModuleDeploymentContract({
      ...contract,
      manifest: {
        ...contract.manifest,
        dependencies: { core: [], externalSystems: [], modules: [] },
      },
    }),
  ).toThrow();
  expect(() => decodeOntosModuleDeploymentContract({ ...contract, schemaVersion: '0' })).toThrow();
  expect(() => decodeOntosModuleDeploymentContract({ ...contract, schemaVersion: '999' })).toThrow();
});

it('accepts declared external identity providers and rejects malformed or duplicate namespaces', () => {
  const provider = {
    admissionDeadlineMs: 5000,
    authenticationNamespaceId: 'ontos.example.portal.v1',
    provider: 'example-provider',
    verification: { operation: 'example-portal.verify.v1', path: '/portal/internal/verify' },
  };
  const withProviders = (externalIdentityProviders: readonly (typeof provider)[]) => ({
    ...emptyManifestInput(),
    publicSurface: { ...emptyManifestInput().publicSurface, externalIdentityProviders },
  });
  expect(defineOntosModuleManifest(withProviders([provider])).publicSurface.externalIdentityProviders).toEqual([
    provider,
  ]);
  expect(() => defineOntosModuleManifest(withProviders([provider, provider]))).toThrow();
  expect(() => defineOntosModuleManifest(withProviders([{ ...provider, admissionDeadlineMs: 0 }]))).toThrow();
  expect(() =>
    defineOntosModuleManifest(
      withProviders([{ ...provider, verification: { ...provider.verification, path: 'portal/verify' } }]),
    ),
  ).toThrow();
});

it('accepts exact isolated API cookies and rejects reserved, foreign or ambiguous credential policies', () => {
  const policy = {
    cookieNames: ['example-portal.session_token', '__Secure-example-portal.session_token'],
    realmPrefix: 'example-portal',
    routes: [{ method: 'GET', path: '/api/customer-account' }],
  } as const;
  const withPolicy = (
    apiCookieTransport: readonly {
      cookieNames: readonly string[];
      realmPrefix: string;
      routes: readonly { method: 'GET'; path: string }[];
    }[],
  ) => ({
    ...emptyManifestInput(),
    publicSurface: { ...emptyManifestInput().publicSurface, apiCookieTransport },
  });
  const accepted = defineOntosModuleManifest({
    ...emptyManifestInput(),
    publicSurface: { ...emptyManifestInput().publicSurface, apiCookieTransport: [policy] },
  });
  expect(accepted.publicSurface.apiCookieTransport).toEqual([policy]);
  expect(Object.isFrozen(accepted.publicSurface.apiCookieTransport?.[0]?.routes)).toBe(true);
  const invalidPolicies: Parameters<typeof withPolicy>[0] = [
    ...['better-auth', 'shell', 'staff', 'ontos'].map((realmPrefix) => ({
      ...policy,
      cookieNames: [`${realmPrefix}.session_token`],
      realmPrefix,
    })),
    { ...policy, cookieNames: ['better-auth.session_token'] },
    { ...policy, cookieNames: ['__Secure-better-auth.session_token'] },
    { ...policy, cookieNames: ['__Host-better-auth.session_token'] },
    { ...policy, cookieNames: ['another-portal.session_token'] },
    { ...policy, cookieNames: ['example-portal.session_token', 'example-portal.session_token'] },
    { ...policy, cookieNames: ['example-portal.*'] },
    { ...policy, routes: [{ method: 'GET', path: '/api/customer-account/../staff' }] },
    { ...policy, routes: [{ method: 'GET', path: '/api/customer-account?scope=staff' }] },
    { ...policy, routes: [policy.routes[0], policy.routes[0]] },
  ];
  for (const invalidPolicy of invalidPolicies) {
    expect(() => defineOntosModuleManifest(withPolicy([invalidPolicy]))).toThrow();
  }
  expect(() => defineOntosModuleManifest(withPolicy([policy, policy]))).toThrow();
});

const firstValue = <Value>(values: readonly Value[]): Value => {
  const [value] = values;
  if (value === undefined) {
    throw new Error('Expected a fixture item');
  }
  return value;
};

const presentationPageEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'property.registry.page.units',
  moduleKey: 'property.registry',
  role: 'page',
});

const presentationArchivePageEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'property.registry.page.unit-archive',
  moduleKey: 'property.registry',
  role: 'page',
});

const presentationSearchEntrypoint = defineTenantModuleEntrypoint({
  access: 'read',
  authorization: { kind: 'context_permission', permission: 'module.access' },
  entrypointKey: 'property.registry.search.units',
  moduleKey: 'property.registry',
  role: 'search',
});

const presentedShellContributions = () =>
  Schema.decodeUnknownSync(OntosShellContributionsSchema)({
    mediaAttachments: [],
    navigation: [],
    pages: [
      {
        componentKey: 'property.registry.dashboard',
        contributionKey: 'property.registry.page.units',
        entrypoint: presentationPageEntrypoint,
        expose: './Units',
        routePath: '/property-units/:unitId',
      },
      {
        componentKey: 'property.registry.dashboard',
        contributionKey: 'property.registry.page.unit-archive',
        entrypoint: presentationArchivePageEntrypoint,
        expose: './Units',
        routePath: '/property-unit-archive',
      },
    ],
    publicComponents: [],
    reports: [],
    resourceDetails: [],
    search: [
      {
        contributionKey: 'property.registry.search.units',
        entrypoint: presentationSearchEntrypoint,
        presentation: {
          agendaPageKeys: ['property.registry.page.unit-archive'],
          family: {
            icon: 'icon-[mdi--office-building-outline]',
            key: 'property',
            label: { cs: 'Nemovitosti', en: 'Property' },
            order: 10,
          },
          group: {
            icon: 'icon-[mdi--door-open]',
            key: 'unit',
            label: { cs: 'Jednotky', en: 'Units' },
            order: 20,
          },
          record: {
            pageKey: 'property.registry.page.units',
            selector: {
              idEncoding: 'native',
              idFormat: 'uuid',
              kind: 'path',
              parameterName: 'unitId',
            },
          },
          refinement: { kind: 'matched_variant', parameterName: 'variantId' },
          scope: 'company',
        },
        searchKey: 'property.unit-search',
      },
    ],
    timelines: [],
  });

const presentedManifestInput = () => ({
  ...emptyManifestInput(),
  publicSurface: {
    ...emptyManifestInput().publicSurface,
    components: { dashboard: componentValue },
    resourceTypes: [
      {
        capabilities: {
          graphVisible: true,
          linkable: true,
          mediaAttachable: false,
          searchable: true,
          timelineVisible: false,
        },
        description: 'A physical unit',
        key: 'property.unit',
        label: 'Unit',
        owningModuleId: 'property.registry',
      },
    ],
    search: [
      {
        accessFiltering: 'legal_entity_scope' as const,
        key: 'property.unit-search',
        owningModuleId: 'property.registry',
        resourceType: 'property.unit',
      },
    ],
    shellContributions: presentedShellContributions(),
  },
});

const presentedDeploymentContract = () => {
  const manifest = defineOntosModuleManifest(presentedManifestInput());
  return {
    deployment: { appId: 'property-registry', buildMarker: 'build-presentation' },
    manifest: {
      activation: manifest.activation,
      module: manifest.module,
      publicSurface: {
        actions: [],
        api: [],
        components: [],
        events: [],
        reports: [],
        resourceTypes: manifest.publicSurface.resourceTypes,
        search: manifest.publicSurface.search,
        shellContributions: manifest.publicSurface.shellContributions,
      },
    },
    runtime: { outboxSubscriptions: [] },
    schemaVersion: ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  };
};

const tenantPresentation = () => {
  const { presentation } = firstValue(presentedShellContributions().search);
  if (presentation === undefined || presentation.agendaPageKeys === undefined || presentation.record === undefined) {
    throw new Error('Expected a complete presentation fixture');
  }
  return {
    agendaPageKeys: presentation.agendaPageKeys,
    family: presentation.family,
    group: presentation.group,
    record: presentation.record,
    scope: 'tenant' as const,
  };
};

const withPresentation = <Presentation>(presentation: Presentation) => {
  const input = presentedManifestInput();
  const [baseContribution] = input.publicSurface.shellContributions.search;
  if (baseContribution === undefined) {
    throw new Error('Expected a search contribution fixture');
  }
  const candidate = {
    ...input,
    publicSurface: {
      ...input.publicSurface,
      shellContributions: {
        ...input.publicSurface.shellContributions,
        search: [{ ...baseContribution }],
      },
    },
  };
  const [target] = candidate.publicSurface.shellContributions.search;
  if (target === undefined) {
    throw new Error('Expected a search contribution candidate');
  }
  // The manifest schema, not the compiler, must judge intentionally malformed presentation values.
  Object.defineProperty(target, 'presentation', { value: presentation });
  return candidate;
};

it('defines, freezes and serializes exact same-owner search presentation data', () => {
  const manifest = defineOntosModuleManifest(presentedManifestInput());
  const { presentation } = firstValue(manifest.publicSurface.shellContributions.search);
  expect(presentation?.record?.pageKey).toBe('property.registry.page.units');
  expect(presentation?.scope).toBe('company');
  expect(Object.isFrozen(presentation)).toBe(true);
  expect(Object.isFrozen(presentation?.group)).toBe(true);
  expect(Object.isFrozen(presentation?.agendaPageKeys)).toBe(true);

  const contract = presentedDeploymentContract();
  expect(decodeOntosModuleDeploymentContract(contract)).toEqual(contract);
  expect(structuredClone(contract)).toEqual(contract);

  const tampered = presentedDeploymentContract();
  expect(() =>
    decodeOntosModuleDeploymentContract({
      ...tampered,
      manifest: {
        ...tampered.manifest,
        publicSurface: {
          ...tampered.manifest.publicSurface,
          shellContributions: {
            ...tampered.manifest.publicSurface.shellContributions,
            search: [
              {
                ...firstValue(tampered.manifest.publicSurface.shellContributions.search),
                presentation: tenantPresentation(),
              },
            ],
          },
        },
      },
    }),
  ).toThrow(/scope/u);
});

it('accepts a tenant-scoped presentation with native IDs and no fabricated company', () => {
  const input = presentedManifestInput();
  const candidate = {
    ...input,
    publicSurface: {
      ...input.publicSurface,
      search: [
        {
          ...firstValue(input.publicSurface.search),
          accessFiltering: 'tenant_scope' as const,
          tenantPermission: 'access' as const,
        },
      ],
      shellContributions: {
        ...input.publicSurface.shellContributions,
        search: [
          {
            ...firstValue(input.publicSurface.shellContributions.search),
            presentation: tenantPresentation(),
          },
        ],
      },
    },
  };
  const manifest = defineOntosModuleManifest(candidate);
  const { presentation } = firstValue(manifest.publicSurface.shellContributions.search);
  expect(presentation?.scope).toBe('tenant');
  expect(presentation?.record?.selector.idEncoding).toBe('native');
  expect(presentation !== undefined && 'refinement' in presentation).toBe(false);
});

it('rejects presentation that is not bound to the exact declared search descriptor and owner resource', () => {
  expect(() => defineOntosModuleManifest(withPresentation(tenantPresentation()))).toThrow(/scope/u);

  const tenant = presentedManifestInput();
  expect(() =>
    defineOntosModuleManifest({
      ...tenant,
      publicSurface: {
        ...tenant.publicSurface,
        search: [
          {
            ...firstValue(tenant.publicSurface.search),
            accessFiltering: 'tenant_scope',
            tenantPermission: 'access',
          },
        ],
      },
    }),
  ).toThrow(/scope/u);

  const foreignOwner = presentedManifestInput();
  expect(() =>
    defineOntosModuleManifest({
      ...foreignOwner,
      publicSurface: {
        ...foreignOwner.publicSurface,
        search: [{ ...firstValue(foreignOwner.publicSurface.search), owningModuleId: 'billing.core' }],
      },
    }),
  ).toThrow(/owned/u);

  const missingResource = presentedManifestInput();
  expect(() =>
    defineOntosModuleManifest({
      ...missingResource,
      publicSurface: {
        ...missingResource.publicSurface,
        search: [{ ...firstValue(missingResource.publicSurface.search), resourceType: 'property.missing' }],
      },
    }),
  ).toThrow(/undeclared resource type/u);

  const missingPage = presentedManifestInput();
  const missingSearch = firstValue(missingPage.publicSurface.shellContributions.search);
  const { presentation: missingPresentation } = missingSearch;
  if (missingPresentation === undefined) {
    throw new Error('Expected a presentation fixture');
  }
  const missingPageCandidate = {
    ...missingPage,
    publicSurface: {
      ...missingPage.publicSurface,
      shellContributions: {
        ...missingPage.publicSurface.shellContributions,
        search: [
          {
            ...missingSearch,
            presentation: {
              ...missingPresentation,
              record: {
                pageKey: 'property.registry.page.missing',
                selector: {
                  idEncoding: 'native' as const,
                  idFormat: 'uuid' as const,
                  kind: 'path' as const,
                  parameterName: 'unitId',
                },
              },
            },
          },
        ],
      },
    },
  };
  expect(() => defineOntosModuleManifest(missingPageCandidate)).toThrow(/undeclared page contribution/u);

  const wrongParameter = presentedManifestInput();
  const wrongSearch = firstValue(wrongParameter.publicSurface.shellContributions.search);
  const { presentation: wrongPresentation } = wrongSearch;
  if (wrongPresentation === undefined || wrongPresentation.record === undefined) {
    throw new Error('Expected a record fixture');
  }
  const wrongParameterCandidate = {
    ...wrongParameter,
    publicSurface: {
      ...wrongParameter.publicSurface,
      shellContributions: {
        ...wrongParameter.publicSurface.shellContributions,
        search: [
          {
            ...wrongSearch,
            presentation: {
              ...wrongPresentation,
              record: {
                ...wrongPresentation.record,
                selector: { ...wrongPresentation.record.selector, parameterName: 'otherId' },
              },
            },
          },
        ],
      },
    },
  };
  expect(() => defineOntosModuleManifest(wrongParameterCandidate)).toThrow(/only existing route parameter/u);

  const { presentation: basePresentation } = firstValue(
    presentedManifestInput().publicSurface.shellContributions.search,
  );
  if (basePresentation === undefined || basePresentation.agendaPageKeys === undefined) {
    throw new Error('Expected a complete presentation fixture');
  }
  expect(() =>
    defineOntosModuleManifest(
      withPresentation({
        agendaPageKeys: basePresentation.agendaPageKeys,
        family: basePresentation.family,
        group: basePresentation.group,
        refinement: { kind: 'matched_variant', parameterName: 'variantId' },
        scope: basePresentation.scope,
      }),
    ),
  ).toThrow();
  expect(() =>
    defineOntosModuleManifest(
      withPresentation({
        family: basePresentation.family,
        group: basePresentation.group,
        kind: 'system',
        navigationPath: '/sprava/lide-a-role',
        scope: basePresentation.scope,
      }),
    ),
  ).toThrow();
});
