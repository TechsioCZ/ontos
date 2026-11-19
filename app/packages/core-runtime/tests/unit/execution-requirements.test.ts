import { Context, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { trustVerifiedGatewayPrincipalContext } from '../../src/auth/system-principal-context-provenance.ts';
import { CallRequirements } from '../../src/execution/call-requirements.ts';
import type { CallerSource } from '../../src/execution/contract.ts';
import { CallRequirementsLive, selectCaller } from '../../src/execution/requirements.ts';
import { defineOntosModuleManifest, OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import {
  declaredCallsIssues,
  moduleDependencyDeclarationsIssue,
  OntosModuleRequirementsSchema,
} from '../../src/modules/module-dependency-contracts.ts';
import type { OntosModuleRequirements } from '../../src/modules/module-dependency-contracts.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { withModuleOperationExecution } from '../../src/modules/module-operation-execution.ts';
import { OntosRegisteredWorkloadCallsSchema } from '../../src/modules/registered-workload-calls.ts';
import type { OntosRegisteredWorkloadCall } from '../../src/modules/registered-workload-calls.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { coreOperations } from '../../src/sdk/core-operations.ts';
import {
  declaredCall,
  declaredWriteCall,
  ExecutionIdentitySchema,
  moduleOperation,
  RequirementCallerSchema,
} from '../../src/sdk/index.ts';
import type { DeclaredCalls, ExecutionIdentity } from '../../src/sdk/index.ts';
import type { ReadCalls } from '../../src/sdk/read.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { fixtureReadAccess } from '../support/access-declaration-fixtures.ts';
import { makeInstalledCatalogFixture } from '../support/installed-catalog.ts';

/**
 * The requirement side of a call: the one caller identity an execution implies, the definition-time
 * check of every declared call against the calling module's manifest, and the requirement lookup in
 * the executing operation's lease.
 */

const consumerModule = 'consumer.alpha';
const consumerEntrypoint = `${consumerModule}.subject-check`;
const providerModule = 'provider.required';
const provider = { entrypointKey: `${providerModule}.resolve`, moduleId: providerModule, schemaVersion: 'owner-v1' };
const declarationKey = `${consumerModule}.subject.read`;
const principalId = '80000000-0000-4000-8000-000000000002';
const revision = 'a'.repeat(64);

const callersOf = Schema.decodeUnknownSync(Schema.Array(RequirementCallerSchema));
const person = callersOf([{ kind: 'person', legalEntityScope: 'subject' }]);
const registered = (pinPrincipal: boolean) =>
  callersOf([{ declarationKey, kind: 'registered', legalEntityScope: 'tenant', pinPrincipal }]);
/** Facts of an execution that is no recovery: there is no request hash to bind. */
const facts = { principalId, recoveryRequestHash: Option.getOrUndefined(Option.none<string>()) };
const request = (via: 'person' | 'recovery' | 'system' | 'workload'): ExecutionIdentity => ({ _tag: 'Request', via });

const providerRead = moduleOperation({
  kind: 'read',
  path: '/reads/resolve',
  provider,
  request: Schema.Struct({ id: Schema.String }),
  response: Schema.Struct({ ok: Schema.Boolean }),
});
const providerWrite = moduleOperation({
  kind: 'write',
  path: '/actions/change',
  provider,
  request: Schema.Struct({ id: Schema.String }),
  response: Schema.Struct({ ok: Schema.Boolean }),
});

const requirementKey = `${consumerModule}.requirement.provider`;
const coreRequirementKey = `${consumerModule}.requirement.legal-entity`;
type CallersInput = readonly (typeof RequirementCallerSchema.Encoded)[];
const withCallers = <Operation extends object>(operation: Operation, callers: CallersInput | undefined) =>
  callers === undefined ? operation : { ...operation, callers };

const requirementsWith = (input: {
  readonly callers?: CallersInput;
  readonly coreCallers?: CallersInput;
  readonly entrypointKey?: string;
  readonly provider?: typeof provider;
}): OntosModuleRequirements => {
  const vertical = {
    condition: `${consumerModule}.provider-branch`,
    entrypointKey: input.entrypointKey ?? consumerEntrypoint,
    evidence: [`${providerModule}.current-facts`],
    key: requirementKey,
    provider: input.provider ?? provider,
  };
  const core = {
    condition: `${consumerModule}.legal-entity-branch`,
    entrypointKey: consumerEntrypoint,
    evidence: ['core.identity.legal-entity'],
    key: coreRequirementKey,
    provider: coreOperations.legalEntityDetail.provider,
  };
  return Schema.decodeUnknownSync(OntosModuleRequirementsSchema)({
    coreCapabilities: [],
    intrinsic: [],
    operations: [withCallers(vertical, input.callers), withCallers(core, input.coreCallers)],
    schemaVersion: '1',
  });
};

const workloadCall: OntosRegisteredWorkloadCall[] = [
  ...Schema.decodeUnknownSync(OntosRegisteredWorkloadCallsSchema)([
    {
      audience: 'required-provider',
      declarationKey,
      entrypointKey: provider.entrypointKey,
      jobKey: 'subject-check',
      legalEntityScope: 'forbidden',
      schemaVersion: 'owner-v1',
      sourceWorkloadKey: `${consumerModule}.subject-check`,
      workloadKey: `${consumerModule}.subject-check`,
    },
  ]),
];

const validate = (
  calls: DeclaredCalls,
  requirements: OntosModuleRequirements | undefined,
  registeredWorkloadCalls: readonly OntosRegisteredWorkloadCall[] = [],
) =>
  declaredCallsIssues({
    calls,
    consumerEntrypointKey: consumerEntrypoint,
    consumerKind: 'read',
    registeredWorkloadCalls,
    requirements,
  });

const invocation = Schema.decodeUnknownSync(ExecutionIdentitySchema)({
  _tag: 'ActionInvocation',
  actionInvocationId: '00000000-0000-4000-8000-0000000000aa',
  actionKey: `${consumerModule}.change`,
  attempt: 1,
});

/* Caller selection ------------------------------------------------------------------------------ */

it('takes a registered caller declaration key as a plain string, checked as an access key', () => {
  // Written in a manifest exactly like `registeredWorkloadCalls[].declarationKey`, with no constructor.
  const written: OntosModuleRequirements['operations'][number]['callers'] = [
    { declarationKey, kind: 'registered', legalEntityScope: 'tenant', pinPrincipal: false },
  ];
  expect(callersOf(written)).toEqual(written);
  expect(() =>
    callersOf([
      { declarationKey: 'Not An Access Key', kind: 'registered', legalEntityScope: 'tenant', pinPrincipal: false },
    ]),
  ).toThrow();
});

/*
 * The callers the two converted reads declare in their manifests, and what main's hand-built delegation
 * sent for each request kind (`person` is the relayed `Assertion`, `registered` the `RegisteredAssertion`):
 * Market eligibility always relayed the requester (`acquireMarketOwnerDelegation`); price-group
 * resolution relayed it unless the scope carried a verified workload, a recovery included
 * (`price-group-catalog.ts` `authorizedExecutor` with `commerceSourceDelegationSubject`).
 */
const recoveryHash = 'f'.repeat(64);
const compatibilityDeclaration = 'pricing.price-group-catalog.price-group.read.compatibility';
const convertedReads = [
  {
    callers: callersOf([{ kind: 'person', legalEntityScope: 'subject' }]),
    expected: {
      person: { kind: 'person', legalEntityScope: 'subject' },
      recovery: { kind: 'person', legalEntityScope: 'subject' },
      system: { kind: 'person', legalEntityScope: 'subject' },
      workload: { kind: 'person', legalEntityScope: 'subject' },
    },
    read: 'commerce.market-catalog.api.verify-market-eligibility-v1',
  },
  {
    callers: callersOf([
      { kind: 'person', legalEntityScope: 'tenant' },
      { declarationKey: compatibilityDeclaration, kind: 'registered', legalEntityScope: 'tenant', pinPrincipal: false },
    ]),
    expected: {
      person: { kind: 'person', legalEntityScope: 'tenant' },
      recovery: {
        declarationKey: compatibilityDeclaration,
        kind: 'registered',
        legalEntityScope: 'tenant',
        recoveryRequestHash: recoveryHash,
      },
      system: { kind: 'person', legalEntityScope: 'tenant' },
      workload: { declarationKey: compatibilityDeclaration, kind: 'registered', legalEntityScope: 'tenant' },
    },
    read: 'commerce.customer-context.api.customer-price-group-resolution',
  },
] as const;

it.effect('selects for every request kind of both converted reads what main delegated', () =>
  Effect.gen(function* convertedReadSelection() {
    for (const { callers, expected, read } of convertedReads) {
      for (const via of ['person', 'recovery', 'system', 'workload'] as const) {
        const selected = yield* selectCaller(request(via), callers, {
          principalId,
          recoveryRequestHash: via === 'recovery' ? recoveryHash : undefined,
        });
        expect({ read, selected, via }).toEqual({ read, selected: expected[via], via });
      }
    }
  }),
);

it.effect('pins the principal exactly when the caller declares pinPrincipal', () =>
  Effect.gen(function* pinning() {
    expect(yield* selectCaller(request('workload'), registered(true), facts)).toMatchObject({
      expectedPrincipalId: principalId,
    });
    expect(yield* selectCaller(request('workload'), registered(false), facts)).not.toHaveProperty(
      'expectedPrincipalId',
    );
  }),
);

it.effect('refuses a kind the requirement does not permit, a recovery without its hash and an Action invocation', () =>
  Effect.gen(function* refusals() {
    expect((yield* Effect.flip(selectCaller(request('person'), registered(true), facts))).wanted).toBe('person');
    expect((yield* Effect.flip(selectCaller(request('system'), registered(true), facts))).wanted).toBe('person');
    expect((yield* Effect.flip(selectCaller(request('recovery'), registered(false), facts))).wanted).toBe('registered');
    expect((yield* Effect.flip(selectCaller(invocation, [...person, ...registered(true)], facts))).wanted).toBe('none');
  }),
);

/* Definition-time validation -------------------------------------------------------------------- */

it('accepts calls covered by the module manifest', () => {
  const calls = {
    entity: declaredCall(coreOperations.legalEntityDetail, coreRequirementKey),
    subject: declaredCall(providerRead, requirementKey),
  };
  expect(validate(calls, requirementsWith({ callers: person }))).toEqual([]);
  expect(validate(calls, requirementsWith({ callers: registered(true) }), workloadCall)).toEqual([]);
});

it('refuses unknown requirements, another entrypoint and another provider', () => {
  const calls = { subject: declaredCall(providerRead, `${consumerModule}.requirement.unknown`) };
  expect(validate(calls, requirementsWith({ callers: person }))).toEqual([
    expect.stringContaining('is not declared by the module'),
  ]);
  expect(validate(calls, Option.getOrUndefined(Option.none<OntosModuleRequirements>()))).toEqual([
    expect.stringContaining('is not declared by the module'),
  ]);
  const covered = { subject: declaredCall(providerRead, requirementKey) };
  expect(validate(covered, requirementsWith({ callers: person, entrypointKey: `${consumerModule}.other` }))).toEqual([
    expect.stringContaining('belongs to entrypoint'),
  ]);
  expect(
    validate(covered, requirementsWith({ callers: person, provider: { ...provider, schemaVersion: 'owner-v2' } })),
  ).toEqual([expect.stringContaining('another provider')]);
});

it('refuses missing or empty callers on a vertical provider and any callers on a Core provider', () => {
  const vertical = { subject: declaredCall(providerRead, requirementKey) };
  expect(validate(vertical, requirementsWith({}))).toEqual([expect.stringContaining('must declare the callers')]);
  expect(validate(vertical, requirementsWith({ callers: [] }))).toEqual([
    expect.stringContaining('must declare the callers'),
  ]);
  const core = { entity: declaredCall(coreOperations.legalEntityDetail, coreRequirementKey) };
  expect(validate(core, requirementsWith({ callers: person, coreCallers: person }))).toEqual([
    expect.stringContaining('must declare no callers'),
  ]);
});

it('refuses a registered caller with no matching registeredWorkloadCalls entry', () => {
  const calls = { subject: declaredCall(providerRead, requirementKey) };
  expect(validate(calls, requirementsWith({ callers: registered(false) }))).toEqual([
    expect.stringContaining('has no registeredWorkloadCalls entry'),
  ]);
  const otherEntrypoint = workloadCall.map((call) => ({ ...call, entrypointKey: `${providerModule}.other` }));
  expect(validate(calls, requirementsWith({ callers: registered(false) }), otherEntrypoint)).toEqual([
    expect.stringContaining('has no registeredWorkloadCalls entry'),
  ]);
});

it('refuses write calls in a read and a write recovery that names no read call', () => {
  const requirements = requirementsWith({ callers: person });
  const write = declaredWriteCall(providerWrite, requirementKey, 'check');
  expect(validate({ change: write, check: declaredCall(providerRead, requirementKey) }, requirements)).toEqual([
    expect.stringContaining('a read declares only read calls'),
  ]);
  const asAction = declaredCallsIssues({
    calls: { change: write },
    consumerEntrypointKey: consumerEntrypoint,
    consumerKind: 'action',
    registeredWorkloadCalls: [],
    requirements,
  });
  expect(asAction).toEqual([expect.stringContaining('names a read call of the same calls as its recovery')]);
  const recoveredByWrite = declaredCallsIssues({
    calls: { change: write, check: declaredWriteCall(providerWrite, requirementKey, 'change') },
    consumerEntrypointKey: consumerEntrypoint,
    consumerKind: 'action',
    registeredWorkloadCalls: [],
    requirements,
  });
  expect(recoveredByWrite).toHaveLength(2);
});

const manifestIssueOf = (requirements: typeof OntosModuleRequirementsSchema.Encoded) =>
  moduleDependencyDeclarationsIssue({
    api: [],
    moduleId: consumerModule,
    operationContracts: [],
    requirements: Schema.decodeUnknownSync(OntosModuleRequirementsSchema)(requirements),
  });

it('refuses empty callers on a vertical provider and callers on a Core provider in the manifest itself', () => {
  const base = requirementsWith({ callers: person });
  const encoded = Schema.encodeSync(OntosModuleRequirementsSchema)(base);
  const [vertical, core] = encoded.operations;
  if (vertical === undefined || core === undefined) {
    throw new Error('Missing requirement fixtures');
  }
  expect(manifestIssueOf({ ...encoded, operations: [vertical, core] })).toBeUndefined();
  expect(manifestIssueOf({ ...encoded, operations: [{ ...vertical, callers: [] }, core] })).toContain(
    'at least one caller',
  );
  expect(manifestIssueOf({ ...encoded, operations: [vertical, { ...core, callers: person }] })).toContain(
    'must not declare callers',
  );
  expect(
    manifestIssueOf({ ...encoded, operations: [{ ...vertical, callers: [...person, ...person] }, core] }),
  ).toContain('more than once');
});

/* Registration -------------------------------------------------------------------------------- */

const runRead = (calls: ReadCalls) =>
  defineRead(
    {
      accessDeclaration: fixtureReadAccess(consumerModule),
      accessKind: 'detail',
      calls,
      entrypoint: defineTenantModuleEntrypoint({
        access: 'read',
        authorization: { kind: 'protected' },
        entrypointKey: consumerEntrypoint,
        moduleKey: consumerModule,
        role: 'api',
      }),
      evidencePolicy: { captureMode: 'metadata_only', policyKey: `${consumerModule}.subject-check.v1` },
      inputSchema: Schema.Struct({}),
      legalEntityScope: 'optional',
      owningModuleKey: consumerModule,
      policies: [],
      readKey: consumerEntrypoint,
      resultSchema: Schema.Struct({}),
      schemaVersion: '1',
    },
    { run: () => Effect.succeed({ evidence: { resultCount: 0 }, result: {} }) },
    () => Effect.succeed({}),
  );

const manifestOf = (
  requirements: OntosModuleRequirements,
  registeredWorkloadCalls?: typeof OntosRegisteredWorkloadCallsSchema.Encoded,
) => {
  const base = makeModuleContractFixture({ appId: 'consumer-alpha', moduleId: consumerModule }).manifest;
  const manifest = defineOntosModuleManifest({
    ...base,
    publicSurface: { ...base.publicSurface, actions: [], api: {}, components: {} },
    requirements,
  });
  return registeredWorkloadCalls === undefined ? manifest : { ...manifest, registeredWorkloadCalls };
};

it('builds a runtime registration only when every declared call is covered (declaredCallsIssues)', () => {
  const read = runRead({ subject: declaredCall(providerRead, requirementKey) });
  expect(() =>
    defineVerticalRuntimeRegistration({
      actions: [],
      manifest: manifestOf(requirementsWith({ callers: person })),
      outboxWorkers: [],
      reads: [read],
    }),
  ).not.toThrow();
  expect(() =>
    defineVerticalRuntimeRegistration({
      actions: [],
      manifest: manifestOf(requirementsWith({ callers: registered(true) })),
      outboxWorkers: [],
      reads: [read],
    }),
  ).toThrow(/has no registeredWorkloadCalls entry/u);
  expect(() =>
    defineVerticalRuntimeRegistration({
      actions: [],
      manifest: manifestOf(
        requirementsWith({ callers: registered(true) }),
        Schema.encodeSync(OntosRegisteredWorkloadCallsSchema)(workloadCall),
      ),
      outboxWorkers: [],
      reads: [read],
    }),
  ).not.toThrow();
  const unknown = runRead({ subject: declaredCall(providerRead, `${consumerModule}.requirement.unknown`) });
  expect(() =>
    defineVerticalRuntimeRegistration({
      actions: [],
      manifest: manifestOf(requirementsWith({ callers: person })),
      outboxWorkers: [],
      reads: [unknown],
    }),
  ).toThrow(/is not declared by the module/u);
});

it('refuses calls on a { load } read at definition, so a registration never sees one', () => {
  const { descriptor } = runRead({});
  expect(() =>
    defineRead(
      { ...descriptor, calls: { subject: declaredCall(providerRead, requirementKey) } },
      { load: () => Effect.succeed({ evidence: { resultCount: 0 }, result: {} }) },
      () => Effect.succeed({}),
    ),
  ).toThrow();
});

/* Requirement lookup in the lease --------------------------------------------------------------- */

const decodeContract = Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema);

const leaseFixture = () => {
  const requirements = requirementsWith({ callers: person });
  const read = runRead({ subject: declaredCall(providerRead, requirementKey) });
  const consumerBase = makeModuleContractFixture({ appId: 'consumer-alpha', moduleId: consumerModule });
  const consumer = decodeContract({
    ...consumerBase,
    manifest: {
      ...consumerBase.manifest,
      requirements: Schema.encodeSync(OntosModuleRequirementsSchema)(requirements),
    },
  });
  const providerBase = makeModuleContractFixture({ appId: 'required-provider', moduleId: providerModule });
  const providerContract = decodeContract({
    ...providerBase,
    manifest: {
      ...providerBase.manifest,
      publicSurface: {
        ...providerBase.manifest.publicSurface,
        api: [{ key: `${providerModule}.public`, operationKeys: ['resolve'] }],
        operationContracts: [
          {
            apiKey: `${providerModule}.public`,
            entrypoint: defineTenantModuleEntrypoint({
              access: 'read',
              authorization: { kind: 'authenticated_principal' },
              entrypointKey: provider.entrypointKey,
              moduleKey: providerModule,
              role: 'api',
            }),
            operationKey: 'resolve',
            schemaVersion: provider.schemaVersion,
          },
        ],
      },
    },
  });
  const principal = trustVerifiedGatewayPrincipalContext(
    Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: '80000000-0000-4000-8000-000000000003',
      authContextRef: 'better-auth-session:execution-requirements',
      authMethod: 'session',
      principalId,
      tenantId: '80000000-0000-4000-8000-000000000001',
    }),
    revision,
  );
  const lease = {
    loadCatalog: Effect.succeed(makeInstalledCatalogFixture(consumer, providerContract)),
    ownerRegistration: defineVerticalRuntimeRegistration({
      actions: [],
      manifest: manifestOf(requirements),
      outboxWorkers: [],
      reads: [read],
    }),
    phase: 'execution' as const,
    registration: read,
    revision,
    scope: principal,
  };
  return { lease, principal };
};

it.effect('resolves the requirement in the lease with its callers and refuses a provider mismatch', () =>
  Effect.gen(function* resolveInLease() {
    const { lease, principal } = leaseFixture();
    // The caller source holds the very principal the lease was opened for: its verified provenance is
    // bound to that object, so a schema-made copy would not resolve (and could not be delegated).
    const source: CallerSource = { _tag: 'RequestPrincipal', principal };
    const { resolve } = yield* Effect.scoped(
      Layer.build(CallRequirementsLive).pipe(Effect.map((context) => Context.get(context, CallRequirements))),
    );
    const inLease = <A, E>(effect: Effect.Effect<A, E>) => withModuleOperationExecution(lease, effect);
    const resolved = yield* inLease(resolve(requirementKey, providerRead, source));
    expect(resolved).toEqual({
      callers: person,
      compositionRevision: revision,
      consumerAppId: 'consumer-alpha',
      provider,
      providerAppId: 'required-provider',
      requirementKey,
    });
    const core = yield* inLease(resolve(coreRequirementKey, coreOperations.legalEntityDetail, source));
    expect(core).toMatchObject({ callers: [], providerAppId: 'core.identity' });
    const mismatch = yield* inLease(Effect.flip(resolve(requirementKey, coreOperations.legalEntityDetail, source)));
    expect(mismatch.reason).toBe('provider_mismatch');
    const missing = yield* inLease(Effect.flip(resolve(`${consumerModule}.requirement.unknown`, providerRead, source)));
    expect(missing.reason).toBe('not_declared');
    const outsideLease = yield* Effect.flip(resolve(requirementKey, providerRead, source));
    expect(outsideLease.reason).toBe('lease_mismatch');
  }),
);
