import { ModuleAppIdSchema } from '@app/core-runtime/auth/hosted-module-credentials';
import { OntosRegisteredWorkloadCallSchema } from '@app/core-runtime';
import type { RegisteredWorkloadCallReceiver } from '@app/core-runtime';
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { GatewayDelegationError } from '../../api/auth/gateway-delegation-errors.ts';
import {
  GatewayDelegationPolicyUnavailable,
  GatewayModuleBindingSchema,
  ModuleCredentialEnrolmentSource,
  admitIntegrationCredential,
  bindingAttestsSource,
  deriveGatewayModuleBindings,
  isGatewayModuleCredential,
  loadGatewayModuleBindings,
} from '../../api/auth/gateway-delegation-policy.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';
import {
  ModuleCredentialBootIdSchema,
  ModuleCredentialHostIdSchema,
} from '../../api/auth/module-credential-attestation.ts';

const revision = 'a'.repeat(64);
const otherRevision = 'b'.repeat(64);
const binding = Schema.decodeUnknownSync(GatewayModuleBindingSchema)({
  compositionRevision: revision,
  providerKeyId: 'order-module-key',
  sourceAppId: 'commerce-order',
  sourceBuildMarker: 'order-build',
});
const source = { aud: 'commerce-order', compositionRevision: revision, targetBuildMarker: 'order-build' };
/** A key the issuing host attested for this module build and release, as the platform records it with the key. */
const attested = (appId: string, buildMarker: string, compositionRevision: string) =>
  Option.some({
    appId: ModuleAppIdSchema.make(appId),
    bootId: ModuleCredentialBootIdSchema.make('00000000-0000-4000-8000-000000000001'),
    buildMarker,
    compositionRevision,
    hostId: ModuleCredentialHostIdSchema.make('fixture-host'),
    ontosModuleCredential: 'attested_v2' as const,
  });
const orderCredential = {
  appId: 'commerce-order',
  attestation: attested('commerce-order', 'order-build', revision),
  providerKeyId: 'order-module-key',
};
const installed = {
  composition: { revision },
  contracts: [{ deployment: { appId: 'commerce-order', buildMarker: 'order-build' } }],
};

it('attests a source only when its app, build and release all match the enrolled module', () => {
  expect(bindingAttestsSource(binding, source, revision)).toBe(true);
  expect(bindingAttestsSource(binding, { ...source, aud: 'commerce-market-catalog' }, revision)).toBe(false);
  expect(bindingAttestsSource(binding, { ...source, targetBuildMarker: 'other-build' }, revision)).toBe(false);
  expect(bindingAttestsSource(binding, { ...source, compositionRevision: otherRevision }, otherRevision)).toBe(false);
  expect(bindingAttestsSource(binding, source, otherRevision)).toBe(false);
});

it('recognises a module credential only by its own enrolled key id', () => {
  expect(isGatewayModuleCredential([orderCredential], 'order-module-key')).toBe(true);
  expect(isGatewayModuleCredential([orderCredential], 'integration-key')).toBe(false);
  expect(isGatewayModuleCredential([], 'order-module-key')).toBe(false);
});

it('accepts any topology app as a module and rejects identities that are not app ids', () => {
  expect(Schema.is(GatewayModuleBindingSchema)(binding)).toBe(true);
  expect(Schema.is(GatewayModuleBindingSchema)({ ...binding, sourceAppId: 'Arbitrary Owner' })).toBe(false);
});

it.effect('derives each installed module credential pinned to that module build and the installed release', () =>
  Effect.gen(function* derivedBindings() {
    expect(yield* deriveGatewayModuleBindings([orderCredential], installed)).toEqual([binding]);
    // Both credentials of a module bind while a newer pass overlaps the older one.
    // Two hosts of the same release (a restart, a second container) hold keys attested for it: both bind.
    const rotated = yield* deriveGatewayModuleBindings(
      [orderCredential, { ...orderCredential, providerKeyId: 'order-module-key-2' }],
      installed,
    );
    expect(rotated.map((entry) => entry.providerKeyId)).toEqual(['order-module-key', 'order-module-key-2']);
    expect(rotated.every((entry) => entry.compositionRevision === revision)).toBe(true);
  }),
);

it.effect('binds a key only for the module build and release its issuing host attested', () =>
  Effect.gen(function* attestedOnly() {
    // Deploy overlap: the older host's key names the older release and build, the newer host's key the newer ones.
    // Only the keys of the release the Shell has installed bind; the other host's keys bind nothing.
    const olderHost = {
      appId: 'commerce-order',
      attestation: attested('commerce-order', 'order-build-older', otherRevision),
      providerKeyId: 'older-host-key',
    };
    const sameBuildOtherRelease = {
      appId: 'commerce-order',
      attestation: attested('commerce-order', 'order-build', otherRevision),
      providerKeyId: 'other-release-key',
    };
    const otherBuildSameRelease = {
      appId: 'commerce-order',
      attestation: attested('commerce-order', 'order-build-older', revision),
      providerKeyId: 'other-build-key',
    };
    const unattested = { appId: 'commerce-order', attestation: Option.none(), providerKeyId: 'unattested-key' };
    const foreignModule = {
      appId: 'commerce-order',
      attestation: attested('commerce-cart', 'order-build', revision),
      providerKeyId: 'foreign-module-key',
    };
    const bindings = yield* deriveGatewayModuleBindings(
      [olderHost, sameBuildOtherRelease, otherBuildSameRelease, unattested, foreignModule, orderCredential],
      installed,
    );
    expect(bindings).toEqual([binding]);
    // Once the older release is installed again (a rollback), only its keys bind.
    const rolledBack = yield* deriveGatewayModuleBindings([olderHost, orderCredential], {
      composition: { revision: otherRevision },
      contracts: [{ deployment: { appId: 'commerce-order', buildMarker: 'order-build-older' } }],
    });
    expect(rolledBack.map((entry) => entry.providerKeyId)).toEqual(['older-host-key']);
  }),
);

it.effect('binds nothing for a module the installed release does not run', () =>
  Effect.gen(function* notInstalled() {
    expect(
      yield* deriveGatewayModuleBindings(
        [
          {
            appId: 'commerce-cart',
            attestation: attested('commerce-cart', 'cart-build', revision),
            providerKeyId: 'cart-module-key',
          },
        ],
        installed,
      ),
    ).toEqual([]);
  }),
);

it.effect('refuses two bindings under one credential', () =>
  Effect.gen(function* duplicateBindings() {
    const exit = yield* Effect.exit(deriveGatewayModuleBindings([orderCredential, orderCredential], installed));
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

// Registered-workload calls (demo divergence exception 8): the shapes of origin/main 5608aae1d
// symmy-c14-customer-rules.mts, declared by the calling module's manifest and kept only while the receiver takes them.
const job = 'integration.symmy.execute-symmy-job';
const createParty = {
  audience: 'party-registry',
  declarationKey: 'party.registry.party.create',
  entrypointKey: 'party.registry.create-party',
  jobKey: job,
  legalEntityScope: 'optional',
  schemaVersion: '1',
  workerKey: job,
  workloadKey: 'party.registry.source-write',
} as const;
const sourceProcessing = {
  audience: 'privacy',
  declarationKey: 'privacy.core.source-processing-eligibility.read',
  entrypointKey: 'privacy.core.api.source-processing-eligibility',
  jobKey: job,
  legalEntityScope: 'required',
  schemaVersion: '1',
  workerKey: job,
  workloadKey: 'privacy.core.source-processing-check',
} as const;
type ReceiverSurface = RegisteredWorkloadCallReceiver['manifest']['publicSurface'];
type ReceiverAction = ReceiverSurface['actions'][number];
type ReceiverCarrier = NonNullable<NonNullable<ReceiverSurface['operationContracts']>[number]['workloadCarrier']>;
const surface = (
  actions: ReceiverSurface['actions'] = [],
  operationContracts: ReceiverSurface['operationContracts'] = [],
) => ({
  publicSurface: { actions, operationContracts },
});
const declaredAction: ReceiverAction = {
  accessDeclaration: { key: createParty.declarationKey },
  accessWorkload: { workloads: [createParty.workloadKey] },
  entrypoint: { entrypointKey: createParty.entrypointKey },
  schemaVersion: '1',
};
const partyReceiver = (action: ReceiverAction = declaredAction) => ({
  deployment: { appId: 'party-registry', buildMarker: 'party-build' },
  manifest: surface([action]),
});
const privacyReceiver = (workloadCarrier: ReceiverCarrier | null = null) => {
  const operation = { entrypoint: { entrypointKey: sourceProcessing.entrypointKey }, schemaVersion: '1' };
  return {
    deployment: { appId: 'privacy', buildMarker: 'privacy-build' },
    manifest: surface([], [workloadCarrier === null ? operation : { ...operation, workloadCarrier }]),
  };
};
const decodeCalls = Schema.decodeUnknownSync(Schema.Array(OntosRegisteredWorkloadCallSchema));
const symmyCaller = (registeredWorkloadCalls: readonly unknown[] | null) => {
  const manifest = surface();
  return {
    deployment: { appId: 'symmy-integration', buildMarker: 'symmy-build' },
    manifest:
      registeredWorkloadCalls === null
        ? manifest
        : { ...manifest, registeredWorkloadCalls: decodeCalls(registeredWorkloadCalls) },
  };
};
const symmyCredential = {
  appId: 'symmy-integration',
  attestation: attested('symmy-integration', 'symmy-build', revision),
  providerKeyId: 'symmy-module-key',
};
const declaredPrivacy = { declarationKey: sourceProcessing.declarationKey, workloads: [sourceProcessing.workloadKey] };
type InstalledFixture = ReturnType<typeof partyReceiver> | ReturnType<typeof privacyReceiver>;
const callsOf = (
  receivers: readonly InstalledFixture[],
  calls: readonly unknown[] | 'none' = [createParty, sourceProcessing],
  credential: Pick<typeof symmyCredential, 'appId' | 'providerKeyId'> & {
    readonly attestation: (typeof symmyCredential)['attestation'] | Option.Option<never>;
  } = symmyCredential,
) =>
  deriveGatewayModuleBindings([credential], {
    composition: { revision },
    contracts: [symmyCaller(calls === 'none' ? null : calls), ...receivers],
  });
const keptOf = (receivers: readonly InstalledFixture[]) =>
  callsOf(receivers).pipe(Effect.map(([bound]) => bound?.registeredWorkloads?.map((call) => call.entrypointKey)));
const { accessDeclaration: _withoutDeclaration, ...undeclaredAction } = declaredAction;
const { accessWorkload: _withoutWorkload, ...subjectOnlyAction } = declaredAction;

it.effect('copies the calls of the attested calling contract that its receivers declare', () =>
  Effect.gen(function* attestedCalls() {
    const [bound] = yield* callsOf([partyReceiver(), privacyReceiver(declaredPrivacy)]);
    expect(bound?.registeredWorkloads).toEqual([createParty, sourceProcessing]);
    // A subject workload of the receiving operation counts as declared too.
    const [subject] = yield* callsOf([
      partyReceiver({ ...subjectOnlyAction, accessActor: { subjectWorkloads: [createParty.workloadKey] } }),
    ]);
    expect(subject?.registeredWorkloads).toEqual([createParty]);
    // A module that declares no calls binds without any.
    const [none] = yield* callsOf([partyReceiver()], 'none');
    expect(none === undefined ? 'unbound' : Object.hasOwn(none, 'registeredWorkloads')).toBe(false);
  }),
);

it.effect('drops a call its receiver does not declare: workload, declaration, version, receiver', () =>
  Effect.gen(function* droppedCalls() {
    expect(yield* keptOf([privacyReceiver(declaredPrivacy)])).toEqual([sourceProcessing.entrypointKey]);
    expect(
      yield* keptOf([
        partyReceiver({ ...declaredAction, accessWorkload: { workloads: ['party.registry.source-read'] } }),
      ]),
    ).toEqual([]);
    expect(
      yield* keptOf([partyReceiver({ ...declaredAction, accessDeclaration: { key: 'party.registry.party.update' } })]),
    ).toEqual([]);
    expect(yield* keptOf([partyReceiver({ ...declaredAction, schemaVersion: '2' })])).toEqual([]);
    expect(yield* keptOf([partyReceiver(undeclaredAction)])).toEqual([]);
    expect(yield* keptOf([privacyReceiver()])).toEqual([]);
    expect(yield* keptOf([privacyReceiver({ ...declaredPrivacy, workloads: ['privacy.core.other-check'] })])).toEqual(
      [],
    );
    expect(yield* keptOf([])).toEqual([]);
  }),
);

it.effect('carries no call for a key whose attestation does not match the installed calling build', () =>
  Effect.gen(function* attestationMismatch() {
    for (const attestation of [
      attested('symmy-integration', 'symmy-build-older', revision),
      attested('symmy-integration', 'symmy-build', otherRevision),
      attested('party-registry', 'symmy-build', revision),
      Option.none(),
    ]) {
      expect(yield* callsOf([partyReceiver()], 'none', { ...symmyCredential, attestation })).toEqual([]);
      expect(
        yield* callsOf([partyReceiver(), privacyReceiver(declaredPrivacy)], [createParty, sourceProcessing], {
          ...symmyCredential,
          attestation,
        }),
      ).toEqual([]);
    }
  }),
);

const unreadable = Effect.fail(new GatewayDelegationPolicyUnavailable({ cause: 'unreadable' }));
const unavailableEnrolment = Layer.succeed(ModuleCredentialEnrolmentSource, {
  load: unreadable,
  loadAttested: unreadable,
});
const orderEnrolment = {
  appId: 'commerce-order',
  authBindingId: '40000000-0000-4000-8000-000000000001',
  boundAt: new Date(0),
  principalId: '20000000-0000-4000-8000-000000000001',
  providerKeyId: 'order-module-key',
};
const enrolledOrder = Layer.succeed(ModuleCredentialEnrolmentSource, {
  load: Effect.succeed([orderEnrolment]),
  loadAttested: Effect.succeed([{ ...orderEnrolment, attestation: orderCredential.attestation }]),
});

it.effect('derives the bindings of the live release from the enrolment and the installed catalog', () =>
  Effect.gen(function* liveBindings() {
    const snapshot = yield* makeCompositionSnapshot([]);
    const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
    // The empty fixture release installs no calling module, so the enrolled credential binds nothing in it.
    const bindings = yield* loadGatewayModuleBindings.pipe(
      Effect.provide(
        Layer.mergeAll(enrolledOrder, Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) })),
      ),
    );
    expect(bindings).toEqual([]);
  }),
);

it.effect('fails the bindings when the enrolment or the installed release cannot be read', () =>
  Effect.gen(function* failsClosed() {
    const snapshot = yield* makeCompositionSnapshot([]);
    const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
    const withoutEnrolment = yield* Effect.exit(
      loadGatewayModuleBindings.pipe(
        Effect.provide(
          Layer.mergeAll(
            unavailableEnrolment,
            Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(withoutEnrolment)).toBe(true);
    const withoutRelease = yield* Effect.exit(
      loadGatewayModuleBindings.pipe(
        Effect.provide(
          Layer.mergeAll(
            enrolledOrder,
            Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.die('the release is unreadable') }),
          ),
        ),
      ),
    );
    expect(Exit.isFailure(withoutRelease)).toBe(true);
  }),
);

const guardCodeOf = (enrolment: Layer.Layer<ModuleCredentialEnrolmentSource>, providerKeyId: string) =>
  Effect.gen(function* guardCode() {
    const exit = yield* Effect.exit(admitIntegrationCredential(providerKeyId).pipe(Effect.provide(enrolment)));
    if (!Exit.isFailure(exit)) {
      return 'admitted';
    }
    const failure = Cause.squash(exit.cause);
    return Schema.is(GatewayDelegationError)(failure) ? failure.code : 'other';
  });

it.effect('refuses any enrolled module key on the integration path and admits an integration key', () =>
  Effect.gen(function* admitsOnlyIntegrationKeys() {
    expect(yield* guardCodeOf(enrolledOrder, 'order-module-key')).toBe('forbidden');
    expect(yield* guardCodeOf(enrolledOrder, 'integration-key')).toBe('admitted');
  }),
);

it.effect('answers an unreadable enrolment as unavailable, never as an integration key', () =>
  Effect.gen(function* failsClosed() {
    expect(yield* guardCodeOf(unavailableEnrolment, 'integration-key')).toBe('unavailable');
  }),
);

it.effect('takes no rule from configuration: the old bindings variable has no effect', () =>
  Effect.gen(function* noConfiguration() {
    const snapshot = yield* makeCompositionSnapshot([]);
    const catalog = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
    const configured = ConfigProvider.fromUnknown({
      ONTOS_GATEWAY_MODULE_BINDINGS: JSON.stringify([
        {
          compositionRevision: snapshot.composition.revision,
          providerKeyId: 'order-module-key',
          registeredWorkloads: [createParty],
          sourceAppId: 'commerce-order',
          sourceBuildMarker: 'order-build',
        },
      ]),
    });
    const bindings = yield* loadGatewayModuleBindings.pipe(
      Effect.provide(
        Layer.mergeAll(enrolledOrder, Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) })),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, configured),
    );
    expect(bindings).toEqual([]);
  }),
);
