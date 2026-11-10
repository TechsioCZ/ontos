import { Cause, Effect, Exit, Layer, Schema } from 'effect';
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

const revision = 'a'.repeat(64);
const otherRevision = 'b'.repeat(64);
const binding = Schema.decodeUnknownSync(GatewayModuleBindingSchema)({
  compositionRevision: revision,
  providerKeyId: 'order-module-key',
  sourceAppId: 'commerce-order',
  sourceBuildMarker: 'order-build',
});
const source = { aud: 'commerce-order', compositionRevision: revision, targetBuildMarker: 'order-build' };
const orderCredential = { appId: 'commerce-order', providerKeyId: 'order-module-key' };
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
    const rotated = yield* deriveGatewayModuleBindings(
      [orderCredential, { appId: 'commerce-order', providerKeyId: 'order-module-key-2' }],
      installed,
    );
    expect(rotated.map((entry) => entry.providerKeyId)).toEqual(['order-module-key', 'order-module-key-2']);
    expect(rotated.every((entry) => entry.compositionRevision === revision)).toBe(true);
  }),
);

it.effect('binds nothing for a module the installed release does not run', () =>
  Effect.gen(function* notInstalled() {
    expect(
      yield* deriveGatewayModuleBindings([{ appId: 'commerce-cart', providerKeyId: 'cart-module-key' }], installed),
    ).toEqual([]);
  }),
);

it.effect('refuses two bindings under one credential', () =>
  Effect.gen(function* duplicateBindings() {
    const exit = yield* Effect.exit(deriveGatewayModuleBindings([orderCredential, orderCredential], installed));
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

const unavailableEnrolment = Layer.succeed(ModuleCredentialEnrolmentSource, {
  load: Effect.fail(new GatewayDelegationPolicyUnavailable({ cause: 'unreadable' })),
});
const enrolledOrder = Layer.succeed(ModuleCredentialEnrolmentSource, {
  load: Effect.succeed([
    {
      appId: 'commerce-order',
      authBindingId: '40000000-0000-4000-8000-000000000001',
      boundAt: new Date(0),
      principalId: '20000000-0000-4000-8000-000000000001',
      providerKeyId: 'order-module-key',
    },
  ]),
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
