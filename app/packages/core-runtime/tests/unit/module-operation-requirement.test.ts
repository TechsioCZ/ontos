import { registeredGatewayRecoveryPrincipal } from '../support/registered-gateway-recovery.ts';
import {
  readVerifiedGatewayWorkload,
  trustVerifiedGatewayPrincipalContext,
} from '../../src/auth/system-principal-context-provenance.ts';
import { defineRead } from '../../src/reads/definition.ts';
import { defineOutboxWorker } from '../../src/outbox/definition.ts';
import { fixtureReadAccess, fixtureActionAccess } from '../support/access-declaration-fixtures.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import { Context, Deferred, Effect, Fiber, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineAction } from '../../src/actions/definition.ts';
import { agentProposalQueueRead } from '../../src/auth/agent-proposal-queue-read.ts';
import { agentActivityRead } from '../../src/auth/agent-activity-read.ts';
import { agentActivityActorsRead } from '../../src/auth/agent-activity-actors-read.ts';
import { agentProfilesRead } from '../../src/auth/agent-profiles-read.ts';
import { peopleDirectoryRead } from '../../src/auth/people-directory-read.ts';
import { companyAgentDirectoryRead } from '../../src/auth/company-agent-directory-read.ts';
import { identityAdministrationAuditRead } from '../../src/auth/identity-administration-audit-read.ts';
import { staffRoleTemplateBindingsRead } from '../../src/auth/staff-role-template-bindings-read.ts';
import { oauthConnectionRevocationNotesRead } from '../../src/auth/oauth-connection-revocation-notes-read.ts';
import { companyManagedPrincipalsRead } from '../../src/auth/principal-administration-reads.ts';
import { peopleSearchRead } from '../../src/people/people-search.ts';
import type { InstalledModuleCatalog } from '../../src/modules/catalog.ts';
import { OntosModuleRequirementsSchema } from '../../src/modules/module-dependency-contracts.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { defineOntosModuleManifest, OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { isGenuineCoreOperation, withModuleOperationExecution } from '../../src/modules/module-operation-execution.ts';
import {
  requireModuleOperation,
  readModuleOperationRequirement,
} from '../../src/modules/module-operation-requirement.ts';
import { ModuleOperationRequirementError } from '../../src/modules/module-operation-requirement-error.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { makeInstalledCatalogFixture } from '../support/installed-catalog.ts';

const revision = 'a'.repeat(64);

it('recognizes the exact retained Core read registrations, never copied keys or descriptors', () => {
  for (const read of [
    agentProposalQueueRead,
    agentActivityRead,
    agentActivityActorsRead,
    agentProfilesRead,
    peopleDirectoryRead,
    companyAgentDirectoryRead,
    identityAdministrationAuditRead,
    staffRoleTemplateBindingsRead,
    oauthConnectionRevocationNotesRead,
    peopleSearchRead,
    companyManagedPrincipalsRead,
  ]) {
    expect(isGenuineCoreOperation(read), read.descriptor.readKey).toBe(true);
  }
  const recreated = defineRead(
    companyManagedPrincipalsRead.descriptor,
    { load: () => Effect.die('A recreated Core read must never execute') },
    () => Effect.succeed({}),
  );
  expect(isGenuineCoreOperation(recreated)).toBe(false);
  const copiedStaffRoles = { descriptor: staffRoleTemplateBindingsRead.descriptor };
  expect(isGenuineCoreOperation(Object.assign(copiedStaffRoles, staffRoleTemplateBindingsRead))).toBe(false);
  const copied = { descriptor: companyManagedPrincipalsRead.descriptor };
  expect(isGenuineCoreOperation(Object.assign(copied, companyManagedPrincipalsRead))).toBe(false);
});
const privateContextKey = '@app/core-runtime/modules/module-operation-execution/ModuleOperationExecution';
const providerModule = 'provider.required';
const decodeContract = Schema.decodeUnknownSync(OntosModuleDeploymentContractSchema);
const entrypoint = (moduleKey: string) =>
  defineTenantModuleEntrypoint({
    access: 'write',
    authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
    entrypointKey: `${moduleKey}.change`,
    moduleKey,
    role: 'action',
  });
const registration = (moduleId: string, suffix = 'change') =>
  defineAction(
    {
      accessDeclaration: fixtureActionAccess(moduleId),
      accessEvidencePolicy: { captureMode: 'metadata_only', policyKey: `${moduleId}.reads.v1` },
      actionKey: `${moduleId}.${suffix}`,
      auditProfile: 'standard',
      domainErrorSchema: ModuleOperationRequirementError,
      domainEvents: {},
      entrypoint: defineTenantModuleEntrypoint({
        access: 'write',
        authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
        entrypointKey: `${moduleId}.${suffix}`,
        moduleKey: moduleId,
        role: 'action',
      }),
      idempotency: 'required',
      legalEntityScope: 'optional',
      owningModuleKey: moduleId,
      payloadSchema: Schema.Struct({}),
      policies: [],
      resultSchema: Schema.Struct({}),
      schemaVersion: '1',
    },
    () => Effect.succeed({}),
  );
const requirementKey = (moduleId: string) => `${moduleId}.require-provider`;
const consumer = (moduleId: string) => {
  const base = makeModuleContractFixture({ appId: moduleId.replaceAll('.', '-'), moduleId });
  return decodeContract({
    ...base,
    manifest: {
      ...base.manifest,
      requirements: {
        coreCapabilities: [],
        intrinsic: [],
        operations: [
          {
            condition: `${moduleId}.provider-branch`,
            entrypointKey: entrypoint(moduleId).entrypointKey,
            evidence: [`${providerModule}.current-facts`],
            key: requirementKey(moduleId),
            provider: {
              entrypointKey: `${providerModule}.resolve`,
              moduleId: providerModule,
              schemaVersion: 'owner-v1',
            },
          },
        ],
        schemaVersion: '1',
      },
    },
  });
};
const catalog = (version = 'owner-v1'): InstalledModuleCatalog => {
  const base = makeModuleContractFixture({ appId: 'required-provider', moduleId: providerModule });
  const provider = decodeContract({
    ...base,
    manifest: {
      ...base.manifest,
      publicSurface: {
        ...base.manifest.publicSurface,
        api: [{ key: `${providerModule}.public`, operationKeys: ['resolve'] }],
        operationContracts: [
          {
            apiKey: `${providerModule}.public`,
            entrypoint: defineTenantModuleEntrypoint({
              access: 'read',
              authorization: { kind: 'authenticated_principal' },
              entrypointKey: `${providerModule}.resolve`,
              moduleKey: providerModule,
              role: 'api',
            }),
            operationKey: 'resolve',
            schemaVersion: version,
          },
        ],
      },
    },
  });
  return makeInstalledCatalogFixture(consumer('consumer.alpha'), consumer('consumer.beta'), provider);
};
const execution = (moduleId = 'consumer.alpha', installed = catalog()) => {
  const actual = registration(moduleId);
  const base = makeModuleContractFixture({ appId: moduleId.replaceAll('.', '-'), moduleId }).manifest;
  const requirements = Schema.decodeUnknownSync(OntosModuleRequirementsSchema)(
    consumer(moduleId).manifest.requirements,
  );
  const manifest = defineOntosModuleManifest({
    ...base,
    publicSurface: { ...base.publicSurface, actions: [actual], api: {}, components: {} },
    requirements,
  });
  return {
    loadCatalog: Effect.succeed(installed),
    ownerRegistration: defineVerticalRuntimeRegistration({ actions: [actual], manifest, outboxWorkers: [] }),
    phase: 'execution' as const,
    registration: actual,
    revision,
    scope: { tenantId: 'trusted-tenant' },
  };
};

it.effect('requires a genuine private execution lease and rejects a guessed Context tag', () =>
  Effect.gen(function* noCallerMint() {
    const missing = yield* Effect.flip(requireModuleOperation(requirementKey('consumer.alpha')));
    expect(Schema.is(ModuleOperationRequirementError)(missing)).toBe(true);
    expect(missing.code).toBe('module_operation_requirement_unavailable');
    const forgedContext = Context.makeUnsafe(new Map([[privateContextKey, { active: true }]]));
    const forged = yield* Effect.flip(
      requireModuleOperation(requirementKey('consumer.alpha')).pipe(Effect.provide(forgedContext)),
    );
    expect(forged.code).toBe('module_operation_requirement_unavailable');
  }),
);

it.effect('checks only the current entrypoint exact owner operation version and returns no authority', () =>
  Effect.gen(function* exactOperationRequirement() {
    expect(
      yield* withModuleOperationExecution(execution(), requireModuleOperation(requirementKey('consumer.alpha'))),
    ).toBeUndefined();
    const foreign = yield* Effect.flip(
      withModuleOperationExecution(execution(), requireModuleOperation(requirementKey('consumer.beta'))),
    );
    expect(foreign.code).toBe('module_operation_requirement_unsatisfied');
    const incompatible = yield* Effect.flip(
      withModuleOperationExecution(
        execution('consumer.alpha', catalog('owner-v2')),
        requireModuleOperation(requirementKey('consumer.alpha')),
      ),
    );
    expect(incompatible.code).toBe('module_operation_requirement_unsatisfied');
    const wrongEntrypoint = { ...execution(), registration: registration('consumer.alpha', 'other') };
    const mismatched = yield* Effect.flip(
      withModuleOperationExecution(wrongEntrypoint, requireModuleOperation(requirementKey('consumer.alpha'))),
    );
    expect(mismatched.code).toBe('module_operation_requirement_unsatisfied');
    const original = execution();
    const copiedEntrypoint = { ...original, registration: registration('consumer.alpha') };
    const borrowed = yield* Effect.flip(
      withModuleOperationExecution(copiedEntrypoint, requireModuleOperation(requirementKey('consumer.alpha'))),
    );
    expect(borrowed.code).toBe('module_operation_requirement_unavailable');
  }),
);

it.effect('keeps independent branches lazy and closes captured contexts on exit', () =>
  Effect.gen(function* lazyClosedLease() {
    let loads = 0;
    const source = {
      ...execution(),
      loadCatalog: Effect.sync(() => {
        loads += 1;
        return catalog();
      }),
    };
    const escaped = yield* withModuleOperationExecution(source, Effect.context());
    expect(loads).toBe(0);
    const closed = yield* Effect.flip(
      requireModuleOperation(requirementKey('consumer.alpha')).pipe(Effect.provide(escaped)),
    );
    expect(closed.code).toBe('module_operation_requirement_unavailable');
    expect(loads).toBe(0);
  }),
);

it.effect('restores outer leases after nested execution and isolates concurrent consumers', () =>
  Effect.gen(function* nestedAndConcurrentLeases() {
    yield* withModuleOperationExecution(
      execution(),
      Effect.gen(function* outerExecution() {
        yield* requireModuleOperation(requirementKey('consumer.alpha'));
        yield* withModuleOperationExecution(
          execution('consumer.beta'),
          requireModuleOperation(requirementKey('consumer.beta')),
        );
        yield* requireModuleOperation(requirementKey('consumer.alpha'));
      }),
    );
    const alpha = yield* Deferred.make<boolean>();
    const beta = yield* Deferred.make<boolean>();
    const run = (moduleId: string, own: Deferred.Deferred<boolean>, other: Deferred.Deferred<boolean>) =>
      withModuleOperationExecution(
        execution(moduleId),
        Effect.gen(function* interleavedExecution() {
          yield* Deferred.succeed(own, true);
          yield* Deferred.await(other);
          yield* requireModuleOperation(requirementKey(moduleId));
        }),
      );
    yield* Effect.all([run('consumer.alpha', alpha, beta), run('consumer.beta', beta, alpha)], { concurrency: 2 });
  }),
);

it.effect('rejects a forged execution prototype without touching its private getter', () =>
  Effect.gen(function* forgedLeasePrototype() {
    const captured = yield* withModuleOperationExecution(execution(), Effect.context());
    const selection = yield* Schema.decodeUnknownEffect(Schema.Option(Schema.Unknown))(
      captured.mapUnsafe.get(privateContextKey),
    );
    expect(Option.isSome(selection)).toBe(true);
    const lease = Option.isSome(selection) ? selection.value : undefined;
    if (Predicate.isObject(lease)) {
      const prototype = Reflect.getPrototypeOf(lease);
      const forged = yield* Schema.decodeUnknownEffect(Schema.Unknown)(Object.create(prototype));
      const rejected = yield* Effect.flip(
        requireModuleOperation(requirementKey('consumer.alpha')).pipe(
          Effect.provide(Context.makeUnsafe(new Map([[privateContextKey, Option.some(forged)]]))),
        ),
      );
      expect(rejected.code).toBe('module_operation_requirement_unavailable');
    } else {
      expect.fail('The private execution fixture did not capture its own lease');
    }
  }),
);

it.effect('closes failure and interrupted leases before captured contexts can be reused', () =>
  Effect.scoped(
    Effect.gen(function* rejectedAndInterruptedLeases() {
      const capturedFailure = yield* Deferred.make<Context.Context<never>>();
      const expectedFailure = new ModuleOperationRequirementError({
        code: 'module_operation_requirement_unsatisfied',
        reason: 'Fixture rejection',
      });
      yield* Effect.exit(
        withModuleOperationExecution(
          execution(),
          Effect.gen(function* failingExecution() {
            yield* Deferred.succeed(capturedFailure, yield* Effect.context());
            return yield* expectedFailure;
          }),
        ),
      );
      const closedFailure = yield* Effect.flip(
        requireModuleOperation(requirementKey('consumer.alpha')).pipe(
          Effect.provide(yield* Deferred.await(capturedFailure)),
        ),
      );
      expect(closedFailure.code).toBe('module_operation_requirement_unavailable');
      const capturedInterrupt = yield* Deferred.make<Context.Context<never>>();
      const fiber = yield* withModuleOperationExecution(
        execution(),
        Effect.gen(function* interruptedExecution() {
          yield* Deferred.succeed(capturedInterrupt, yield* Effect.context());
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkScoped);
      const retained = yield* Deferred.await(capturedInterrupt);
      yield* Fiber.interrupt(fiber);
      const closedInterrupt = yield* Effect.flip(
        requireModuleOperation(requirementKey('consumer.alpha')).pipe(Effect.provide(retained)),
      );
      expect(closedInterrupt.code).toBe('module_operation_requirement_unavailable');
    }),
  ),
);

it.effect('rejects a reflected genuine constructor without Core mint authority', () =>
  Effect.gen(function* reflectedLeaseConstructor() {
    const captured = yield* withModuleOperationExecution(execution(), Effect.context());
    const selected = yield* Schema.decodeUnknownEffect(Schema.Option(Schema.Unknown))(
      captured.mapUnsafe.get(privateContextKey),
    );
    if (Option.isNone(selected) || selected.value === null || !Predicate.isObjectKeyword(selected.value)) {
      expect.fail('Expected a captured genuine lease');
    }
    const reflectedConstructor: unknown = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(selected.value),
      'constructor',
    )?.value;
    if (!Predicate.isFunction(reflectedConstructor)) {
      expect.fail('Expected a reflected constructor');
    }
    const forged: unknown = Reflect.construct(reflectedConstructor, [execution(), Object.freeze({})]);
    const rejected = yield* Effect.flip(
      requireModuleOperation(requirementKey('consumer.alpha')).pipe(
        Effect.provide(Context.makeUnsafe(new Map([[privateContextKey, Option.some(forged)]]))),
      ),
    );
    expect(rejected.code).toBe('module_operation_requirement_unavailable');
  }),
);

const gatewayScope = (compositionRevision = revision) =>
  trustVerifiedGatewayPrincipalContext(
    Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: '80000000-0000-4000-8000-000000000003',
      authContextRef: 'better-auth-session:operation-contract-fact',
      authMethod: 'session',
      principalId: '80000000-0000-4000-8000-000000000002',
      tenantId: '80000000-0000-4000-8000-000000000001',
    }),
    compositionRevision,
  );

it.effect('reads immutable exact conditional operation facts only from the original live gateway scope', () =>
  Effect.gen(function* factualOperationContract() {
    const scope = gatewayScope();
    const source = { ...execution(), scope };
    const fact = yield* withModuleOperationExecution(
      source,
      readModuleOperationRequirement(requirementKey('consumer.alpha'), scope),
    );
    expect(fact).toEqual({
      compositionRevision: revision,
      consumerEntrypointKey: 'consumer.alpha.change',
      consumerSchemaVersion: '1',
      providerAppId: 'required-provider',
      providerEntrypointKey: 'provider.required.resolve',
      providerModuleId: providerModule,
      providerSchemaVersion: 'owner-v1',
      requirementKey: requirementKey('consumer.alpha'),
      tenantId: scope.tenantId,
    });
    expect(Object.isFrozen(fact)).toBe(true);
    let loads = 0;
    const original = {
      ...source,
      loadCatalog: Effect.sync(() => {
        loads += 1;
        return catalog();
      }),
    };
    for (const supplied of [{ ...scope }, gatewayScope()]) {
      const failure = yield* Effect.flip(
        withModuleOperationExecution(
          original,
          readModuleOperationRequirement(requirementKey('consumer.alpha'), supplied),
        ),
      );
      expect(failure.code).toBe('module_operation_requirement_unavailable');
    }
    expect(loads).toBe(0);
    const missing = yield* Effect.flip(readModuleOperationRequirement(requirementKey('consumer.alpha'), scope));
    expect(missing.code).toBe('module_operation_requirement_unavailable');
    const wrongRevision = gatewayScope('b'.repeat(64));
    const mismatched = yield* Effect.flip(
      withModuleOperationExecution(
        { ...original, scope: wrongRevision },
        readModuleOperationRequirement(requirementKey('consumer.alpha'), wrongRevision),
      ),
    );
    expect(mismatched.code).toBe('module_operation_requirement_unavailable');
    expect(loads).toBe(0);
    const closedContext = yield* withModuleOperationExecution(source, Effect.context());
    const closed = yield* Effect.flip(
      readModuleOperationRequirement(requirementKey('consumer.alpha'), scope).pipe(Effect.provide(closedContext)),
    );
    expect(closed.code).toBe('module_operation_requirement_unavailable');
  }),
);

it.effect(
  'refuses foreign entrypoints, recreated registrations and incompatible providers for factual requirements',
  () =>
    Effect.gen(function* factualRequirementRemainsExact() {
      const scope = gatewayScope();
      for (const row of [
        {
          code: 'module_operation_requirement_unsatisfied',
          key: requirementKey('consumer.beta'),
          source: { ...execution(), scope },
        },
        {
          code: 'module_operation_requirement_unsatisfied',
          key: requirementKey('consumer.alpha'),
          source: { ...execution('consumer.alpha', catalog('owner-v2')), scope },
        },
        {
          code: 'module_operation_requirement_unavailable',
          key: requirementKey('consumer.alpha'),
          source: { ...execution(), registration: registration('consumer.alpha'), scope },
        },
      ]) {
        const failure = yield* Effect.flip(
          withModuleOperationExecution(row.source, readModuleOperationRequirement(row.key, scope)),
        );
        expect(failure.code).toBe(row.code);
      }
    }),
);

it.effect(
  'rechecks the execution lease after a delayed catalog load instead of reviving captured scope authority',
  () =>
    Effect.gen(function* factualLeaseExpiresDuringLoad() {
      const scope = gatewayScope();
      const loading = yield* Deferred.make<string>();
      const release = yield* Deferred.make<InstalledModuleCatalog>();
      const source = {
        ...execution(),
        loadCatalog: Deferred.succeed(loading, 'loading').pipe(Effect.andThen(Deferred.await(release))),
        scope,
      };
      const pending = yield* withModuleOperationExecution(
        source,
        Effect.gen(function* startFactualLoad() {
          const fiber = yield* Effect.forkChild(
            Effect.exit(readModuleOperationRequirement(requirementKey('consumer.alpha'), scope)),
          );
          yield* Deferred.await(loading);
          return fiber;
        }),
      );
      yield* Deferred.succeed(release, catalog());
      const failure = yield* Fiber.join(pending).pipe(Effect.flatMap((exit) => Effect.flip(exit)));
      expect(failure.code).toBe('module_operation_requirement_unavailable');
    }),
);

it.effect(
  'reports the actual registered Read schema version and refuses worker facts without a receiving schema contract',
  () =>
    Effect.gen(function* factualReadAndWorkerContracts() {
      const scope = gatewayScope();
      const moduleId = 'consumer.alpha';
      const read = defineRead(
        {
          accessDeclaration: fixtureReadAccess(moduleId),
          accessKind: 'detail',
          entrypoint: defineTenantModuleEntrypoint({
            access: 'read',
            authorization: { kind: 'context_permission', permission: 'module.access' },
            entrypointKey: `${moduleId}.change`,
            moduleKey: moduleId,
            role: 'api',
          }),
          evidencePolicy: { captureMode: 'metadata_only', policyKey: `${moduleId}.read.v1` },
          inputSchema: Schema.Struct({}),
          legalEntityScope: 'optional',
          owningModuleKey: moduleId,
          permissionTarget: 'module',
          policies: [],
          readKey: `${moduleId}.change`,
          resultSchema: Schema.Struct({}),
          schemaVersion: 'actual-read-v3',
        },
        () => Effect.succeed({ evidence: { resultCount: 0 }, result: {} }),
        () => Effect.succeed({}),
        () => ({ kind: 'module', moduleId }),
      );
      const base = makeModuleContractFixture({ appId: 'consumer-alpha', moduleId }).manifest;
      const { requirements } = consumer(moduleId).manifest;
      if (requirements === undefined) {
        throw new Error('Missing Read owner requirements');
      }
      const manifest = defineOntosModuleManifest({
        ...base,
        publicSurface: { ...base.publicSurface, actions: [], api: {}, components: {} },
        requirements,
      });
      const owner = defineVerticalRuntimeRegistration({ actions: [], manifest, outboxWorkers: [], reads: [read] });
      const fact = yield* withModuleOperationExecution(
        { ...execution(), ownerRegistration: owner, registration: read, scope },
        readModuleOperationRequirement(requirementKey(moduleId), scope),
      );
      expect(fact.consumerSchemaVersion).toBe('actual-read-v3');
      const worker = defineOutboxWorker(
        {
          consumerModuleKey: moduleId,
          entrypoint: defineTenantModuleEntrypoint({
            access: 'background',
            authorization: { kind: 'owner_local_background' },
            entrypointKey: `${moduleId}.worker`,
            moduleKey: moduleId,
            role: 'worker',
          }),
          leaseDurationMs: 30_000,
          legalEntityScope: 'forbidden',
          payloadSchema: Schema.Struct({}),
          producerModuleKey: 'provider.required',
          retryPolicy: { initialBackoffMs: 1000, maxAttempts: 1, maxBackoffMs: 1000, multiplier: 1 },
          topic: 'provider.required.event',
          workerKey: `${moduleId}.worker`,
        },
        () => Effect.void,
      );
      const refused = yield* Effect.flip(
        withModuleOperationExecution(
          { ...execution(), registration: worker, scope },
          readModuleOperationRequirement(requirementKey(moduleId), scope),
        ),
      );
      expect(refused.code).toBe('module_operation_requirement_unavailable');
    }),
);

it.effect('refuses an altered current consumer requirement projection even when its provider still matches', () =>
  Effect.gen(function* factualConsumerProjectionCannotDrift() {
    const scope = gatewayScope();
    const source = consumer('consumer.alpha');
    const { requirements } = source.manifest;
    if (requirements === undefined) {
      throw new Error('Missing owner requirements fixture');
    }
    const altered = decodeContract({
      ...source,
      manifest: {
        ...source.manifest,
        requirements: {
          ...requirements,
          operations: requirements.operations.map((operation) => ({
            ...operation,
            condition: 'consumer.alpha.other-branch',
          })),
        },
      },
    });
    const installed = makeInstalledCatalogFixture(
      ...catalog().contracts.map((contract) => (contract.manifest.module.id === 'consumer.alpha' ? altered : contract)),
    );
    const failure = yield* Effect.flip(
      withModuleOperationExecution(
        { ...execution('consumer.alpha', installed), scope },
        readModuleOperationRequirement(requirementKey('consumer.alpha'), scope),
      ),
    );
    expect(failure.code).toBe('module_operation_requirement_unavailable');
  }),
);

it.effect('rejects signed workload and private-route operation mismatches before reading the catalog', () =>
  Effect.gen(function* signedSourceOperationMatchesActualLease() {
    const plain = gatewayScope();
    let loads = 0;
    const source = {
      ...execution(),
      loadCatalog: Effect.sync(() => {
        loads += 1;
        return catalog();
      }),
    };
    const recovery = registeredGatewayRecoveryPrincipal({
      declarationKey: 'consumer.alpha.write',
      entrypointKey: 'consumer.alpha.change',
      principalId: plain.principalId,
      requestHash: 'a'.repeat(64),
      tenantId: plain.tenantId,
      workloadKey: 'consumer.alpha.source-read',
    });
    const metadata = readVerifiedGatewayWorkload(recovery);
    if (metadata === undefined) {
      throw new Error('Missing signed workload fixture');
    }
    const system = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      authContextRef: recovery.authContextRef,
      authMethod: 'system',
      principalId: plain.principalId,
      tenantId: plain.tenantId,
    });
    for (const mismatch of [
      { entrypointKey: 'consumer.alpha.other', schemaVersion: '1' },
      { entrypointKey: 'consumer.alpha.change', schemaVersion: 'other-v2' },
    ]) {
      const signed = trustVerifiedGatewayPrincipalContext(system, revision, undefined, undefined, {
        ...metadata,
        ...mismatch,
      });
      const failure = yield* Effect.flip(
        withModuleOperationExecution(
          { ...source, scope: signed },
          readModuleOperationRequirement(requirementKey('consumer.alpha'), signed),
        ),
      );
      expect(failure.code).toBe('module_operation_requirement_unavailable');
    }
    const legalEntityId = '80000000-0000-4000-8000-000000000004';
    const routedPrincipal = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
      authBindingId: '80000000-0000-4000-8000-000000000003',
      authContextRef: 'better-auth-api-key:route-operation-fact',
      authenticationNamespaceId: 'integration.source.realm',
      authMethod: 'api_key',
      legalEntityId,
      principalId: plain.principalId,
      tenantId: plain.tenantId,
    });
    for (const operation of [
      { entrypointKey: 'consumer.alpha.other', schemaVersion: '1' },
      { entrypointKey: 'consumer.alpha.change', schemaVersion: 'other-v2' },
    ]) {
      const routed = trustVerifiedGatewayPrincipalContext(routedPrincipal, revision, undefined, undefined, undefined, {
        legalEntityId,
        operations: [operation],
        principalId: plain.principalId,
        routeId: '80000000-0000-4000-8000-000000000005',
        routeKey: 'source-import',
        routeRevision: 'revision-1',
        sourceRouteId: '80000000-0000-4000-8000-000000000006',
        sourceRouteRevision: 'revision-1',
        tenantId: plain.tenantId,
      });
      const failure = yield* Effect.flip(
        withModuleOperationExecution(
          { ...source, scope: routed },
          readModuleOperationRequirement(requirementKey('consumer.alpha'), routed),
        ),
      );
      expect(failure.code).toBe('module_operation_requirement_unavailable');
    }
    expect(loads).toBe(0);
  }),
);
