import { OntosRegisteredWorkloadCallSchema } from '@app/core-runtime';
import type { RegisteredWorkloadCallReceiver } from '@app/core-runtime';
import { Cause, ConfigProvider, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { GatewayDelegationError } from '../../api/auth/gateway-delegation-errors.ts';
import {
  GatewayModuleBindingSchema,
  GatewayModuleCredentialBindingSchema,
  admitIntegrationCredential,
  bindingAttestsSource,
  isGatewayModuleCredential,
  loadGatewayModuleBindings,
  loadGatewayModuleCredentialBindings,
} from '../../api/auth/gateway-delegation-policy.ts';
import { withRegisteredWorkloadCalls } from '../../api/auth/gateway-registered-workload-calls.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../fixtures/application-composition.ts';

const revision = 'a'.repeat(64);
const otherRevision = 'b'.repeat(64);
const binding = Schema.decodeUnknownSync(GatewayModuleBindingSchema)({
  compositionRevision: revision,
  providerKeyId: 'order-module-key',
  sourceAppId: 'commerce-order',
  sourceBuildMarker: 'order-build',
});
const source = { aud: 'commerce-order', compositionRevision: revision, targetBuildMarker: 'order-build' };

it('attests a source only when its app, build and release all match the enrolled module', () => {
  expect(bindingAttestsSource(binding, source, revision)).toBe(true);
  expect(bindingAttestsSource(binding, { ...source, aud: 'commerce-market-catalog' }, revision)).toBe(false);
  expect(bindingAttestsSource(binding, { ...source, targetBuildMarker: 'other-build' }, revision)).toBe(false);
  expect(bindingAttestsSource(binding, { ...source, compositionRevision: otherRevision }, otherRevision)).toBe(false);
  expect(bindingAttestsSource(binding, source, otherRevision)).toBe(false);
});

it('recognises a module credential only by its own enrolled key id', () => {
  expect(isGatewayModuleCredential([binding], 'order-module-key')).toBe(true);
  expect(isGatewayModuleCredential([binding], 'integration-key')).toBe(false);
  expect(isGatewayModuleCredential([], 'order-module-key')).toBe(false);
});

it('accepts any topology app as a module and rejects identities that are not app ids', () => {
  expect(Schema.is(GatewayModuleBindingSchema)(binding)).toBe(true);
  expect(Schema.is(GatewayModuleBindingSchema)({ ...binding, sourceAppId: 'Arbitrary Owner' })).toBe(false);
});

const enrolment = (value?: string) =>
  ConfigProvider.fromUnknown(value === undefined ? {} : { ONTOS_GATEWAY_MODULE_BINDINGS: value });

it.effect('loads no module credentials only when the deployment explicitly enrolls none', () =>
  Effect.gen(function* withoutBindings() {
    const bindings = yield* loadGatewayModuleCredentialBindings.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, enrolment('[]')),
    );
    expect(bindings).toEqual([]);
  }),
);

it.effect(
  'fails when the enrolment variable is missing or malformed, so no module key is read as an integration key',
  () =>
    Effect.gen(function* unreadableBindings() {
      for (const provider of [enrolment(), enrolment('{not json')]) {
        const exit = yield* Effect.exit(
          loadGatewayModuleCredentialBindings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
    }),
);

it.effect('refuses two enrolments under one credential', () =>
  Effect.gen(function* duplicateBindings() {
    const exit = yield* Effect.exit(
      loadGatewayModuleCredentialBindings.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          enrolment(JSON.stringify([binding, { ...binding, sourceAppId: 'commerce-order-2' }])),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

const guardCodeOf = (provider: ConfigProvider.ConfigProvider, providerKeyId: string) =>
  Effect.gen(function* guardCode() {
    const exit = yield* Effect.exit(
      admitIntegrationCredential(providerKeyId).pipe(Effect.provideService(ConfigProvider.ConfigProvider, provider)),
    );
    if (!Exit.isFailure(exit)) {
      return 'admitted';
    }
    const failure = Cause.squash(exit.cause);
    return Schema.is(GatewayDelegationError)(failure) ? failure.code : 'other';
  });

it.effect('refuses a bound module key on the integration path and admits an integration key', () =>
  Effect.gen(function* admitsOnlyIntegrationKeys() {
    const provider = enrolment(JSON.stringify([binding]));
    expect(yield* guardCodeOf(provider, 'order-module-key')).toBe('forbidden');
    expect(yield* guardCodeOf(provider, 'integration-key')).toBe('admitted');
  }),
);

it.effect('answers a missing or malformed enrolment as unavailable, never as an integration key', () =>
  Effect.gen(function* failsClosed() {
    expect(yield* guardCodeOf(enrolment(), 'integration-key')).toBe('unavailable');
    expect(yield* guardCodeOf(enrolment('{not json'), 'integration-key')).toBe('unavailable');
  }),
);

// The calling module's reviewed manifest is the only source of its registered-workload calls; the Shell keeps a call
// only while the installed receiver declares it on that exact operation version.
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
) => ({ publicSurface: { actions, operationContracts } });
const declaredAction: ReceiverAction = {
  accessDeclaration: { key: createParty.declarationKey },
  accessWorkload: { workloads: [createParty.workloadKey] },
  entrypoint: { entrypointKey: createParty.entrypointKey },
  legalEntityScope: 'optional',
  schemaVersion: '1',
};
const partyReceiver = (action: ReceiverAction = declaredAction) => ({
  deployment: { appId: 'party-registry', buildMarker: 'party-build' },
  manifest: surface([action]),
});
const declaredPrivacy: ReceiverCarrier = {
  declarationKey: sourceProcessing.declarationKey,
  workloads: [sourceProcessing.workloadKey],
};
const privacyReceiver = (workloadCarrier: ReceiverCarrier | null = declaredPrivacy) => {
  const operation = { entrypoint: { entrypointKey: sourceProcessing.entrypointKey }, schemaVersion: '1' };
  return {
    deployment: { appId: 'privacy', buildMarker: 'privacy-build' },
    manifest: surface([], [workloadCarrier === null ? operation : { ...operation, workloadCarrier }]),
  };
};
const decodeCalls = Schema.decodeUnknownSync(Schema.Array(OntosRegisteredWorkloadCallSchema));
const symmyCaller = (calls: readonly unknown[] | 'none') => ({
  deployment: { appId: 'symmy-integration', buildMarker: 'symmy-build' },
  manifest: calls === 'none' ? surface() : { ...surface(), registeredWorkloadCalls: decodeCalls(calls) },
});
const symmyCredential = Schema.decodeUnknownSync(GatewayModuleCredentialBindingSchema)({
  compositionRevision: revision,
  providerKeyId: 'symmy-module-key',
  sourceAppId: 'symmy-integration',
  sourceBuildMarker: 'symmy-build',
});
type InstalledFixture = ReturnType<typeof partyReceiver> | ReturnType<typeof privacyReceiver>;
const bound = (
  receivers: readonly InstalledFixture[],
  calls: readonly unknown[] | 'none' = [createParty, sourceProcessing],
  credential = symmyCredential,
) =>
  withRegisteredWorkloadCalls(credential, {
    composition: { revision },
    contracts: [symmyCaller(calls), ...receivers],
  });
const keptOf = (receivers: readonly InstalledFixture[]) =>
  bound(receivers).registeredWorkloads?.map((call) => call.entrypointKey);
const { accessDeclaration: _withoutDeclaration, ...undeclaredAction } = declaredAction;
const { accessWorkload: _withoutWorkload, ...subjectOnlyAction } = declaredAction;

it('keeps the calls of the attested calling contract that its receivers declare', () => {
  expect(bound([partyReceiver(), privacyReceiver()]).registeredWorkloads).toEqual([createParty, sourceProcessing]);
  // A module whose manifest declares no calls keeps its identity and binds without any.
  const none = bound([partyReceiver()], 'none');
  expect(none).toEqual(symmyCredential);
  expect(Object.hasOwn(none, 'registeredWorkloads')).toBe(false);
});

it('drops a call its receiver does not take: workload, declaration, version, operation, receiver, action scope', () => {
  expect(keptOf([privacyReceiver()])).toEqual([sourceProcessing.entrypointKey]);
  expect(
    keptOf([partyReceiver({ ...declaredAction, accessWorkload: { workloads: ['party.registry.source-read'] } })]),
  ).toEqual([]);
  expect(
    keptOf([partyReceiver({ ...declaredAction, accessDeclaration: { key: 'party.registry.party.update' } })]),
  ).toEqual([]);
  expect(keptOf([partyReceiver({ ...declaredAction, schemaVersion: '2' })])).toEqual([]);
  expect(
    keptOf([partyReceiver({ ...declaredAction, entrypoint: { entrypointKey: 'party.registry.update-party' } })]),
  ).toEqual([]);
  expect(keptOf([partyReceiver(undeclaredAction)])).toEqual([]);
  // A subject workload alone is not the receiving action's own workload.
  const subjectOnly = { ...subjectOnlyAction, accessActor: { subjectWorkloads: [createParty.workloadKey] } };
  expect(keptOf([partyReceiver(subjectOnly)])).toEqual([]);
  expect(keptOf([partyReceiver({ ...declaredAction, legalEntityScope: 'required' })])).toEqual([]);
  expect(keptOf([privacyReceiver(null)])).toEqual([]);
  expect(keptOf([privacyReceiver({ ...declaredPrivacy, workloads: ['privacy.core.other-check'] })])).toEqual([]);
  expect(keptOf([])).toEqual([]);
});

it('carries no call for a binding whose build or release is not the installed calling contract', () => {
  for (const credential of [
    { ...symmyCredential, sourceBuildMarker: 'symmy-build-older' },
    { ...symmyCredential, compositionRevision: otherRevision },
    { ...symmyCredential, sourceAppId: 'party-registry' },
  ]) {
    const unbound = bound([partyReceiver(), privacyReceiver()], [createParty, sourceProcessing], credential);
    expect(unbound).toEqual(credential);
    expect(Object.hasOwn(unbound, 'registeredWorkloads')).toBe(false);
  }
});

const installedCatalog = Effect.gen(function* installedCatalog() {
  const snapshot = yield* makeCompositionSnapshot([]);
  return yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
});

it.effect('takes no rule from configuration: a registeredWorkloads key in the enrolment is ignored', () =>
  Effect.gen(function* noConfiguredRules() {
    const catalog = yield* installedCatalog;
    const configured = enrolment(
      JSON.stringify([
        {
          compositionRevision: catalog.composition.revision,
          providerKeyId: 'symmy-module-key',
          registeredWorkloads: [createParty],
          sourceAppId: 'symmy-integration',
          sourceBuildMarker: 'symmy-build',
        },
      ]),
    );
    const credentials = yield* loadGatewayModuleCredentialBindings.pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, configured),
    );
    expect(credentials.map((credential) => Object.hasOwn(credential, 'registeredWorkloads'))).toEqual([false]);
    // The installed release has no calling contract for the credential, so it binds its identity and no rule.
    const bindings = yield* loadGatewayModuleBindings.pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
      Effect.provideService(ConfigProvider.ConfigProvider, configured),
    );
    expect(bindings).toEqual(credentials);
    expect(bindings.map((entry) => Object.hasOwn(entry, 'registeredWorkloads'))).toEqual([false]);
  }),
);

it.effect('fails the bindings when the enrolment or the installed release cannot be read', () =>
  Effect.gen(function* failsClosed() {
    const catalog = yield* installedCatalog;
    const withoutEnrolment = yield* Effect.exit(
      loadGatewayModuleBindings.pipe(
        Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(catalog) }),
        Effect.provideService(ConfigProvider.ConfigProvider, enrolment()),
      ),
    );
    expect(Exit.isFailure(withoutEnrolment)).toBe(true);
    const withoutRelease = yield* Effect.exit(
      loadGatewayModuleBindings.pipe(
        Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.die('the release is unreadable') }),
        Effect.provideService(ConfigProvider.ConfigProvider, enrolment(JSON.stringify([binding]))),
      ),
    );
    expect(Exit.isFailure(withoutRelease)).toBe(true);
  }),
);
