import { Context, Deferred, Effect, Fiber, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { defineAction } from '../../src/actions/definition.ts';
import type { InstalledModuleCatalog } from '../../src/modules/catalog.ts';
import { OntosModuleRequirementsSchema } from '../../src/modules/module-dependency-contracts.ts';
import { defineVerticalRuntimeRegistration } from '../../src/modules/runtime-registration.ts';
import { defineOntosModuleManifest, OntosModuleDeploymentContractSchema } from '../../src/modules/manifest.ts';
import { defineTenantModuleEntrypoint } from '../../src/modules/module-entrypoint.ts';
import { withModuleOperationExecution } from '../../src/modules/module-operation-execution.ts';
import { requireModuleOperation } from '../../src/modules/module-operation-requirement.ts';
import { ModuleOperationRequirementError } from '../../src/modules/module-operation-requirement-error.ts';
import { makeModuleContractFixture } from '../../src/testing/module-contract.ts';
import { makeInstalledCatalogFixture } from '../support/installed-catalog.ts';

const revision = 'a'.repeat(64);
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
