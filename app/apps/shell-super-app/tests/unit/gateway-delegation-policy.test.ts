import { Cause, ConfigProvider, Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { GatewayDelegationError } from '../../api/auth/gateway-delegation-errors.ts';
import {
  GatewayModuleBindingSchema,
  admitIntegrationCredential,
  bindingAttestsSource,
  isGatewayModuleCredential,
  loadGatewayModuleBindings,
} from '../../api/auth/gateway-delegation-policy.ts';

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

it.effect('loads no module credentials only when the deployment explicitly enrolls none', () =>
  Effect.gen(function* withoutBindings() {
    const bindings = yield* loadGatewayModuleBindings.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ ONTOS_GATEWAY_MODULE_BINDINGS: '[]' }),
      ),
    );
    expect(bindings).toEqual([]);
  }),
);

it.effect('fails when the enrolment variable is missing, so no module key is ever read as an integration key', () =>
  Effect.gen(function* missingBindings() {
    const exit = yield* Effect.exit(
      loadGatewayModuleBindings.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect('fails when the enrolment variable is malformed', () =>
  Effect.gen(function* malformedBindings() {
    const exit = yield* Effect.exit(
      loadGatewayModuleBindings.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ONTOS_GATEWAY_MODULE_BINDINGS: '{not json' }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);

it.effect('loads enrolled module credentials from the issuer-owned configuration', () =>
  Effect.gen(function* withBindings() {
    const bindings = yield* loadGatewayModuleBindings.pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ ONTOS_GATEWAY_MODULE_BINDINGS: JSON.stringify([binding]) }),
      ),
    );
    expect(bindings).toEqual([binding]);
  }),
);

const enrolment = (value?: string) =>
  ConfigProvider.fromUnknown(value === undefined ? {} : { ONTOS_GATEWAY_MODULE_BINDINGS: value });

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

it.effect('refuses two enrolments under one credential', () =>
  Effect.gen(function* duplicateBindings() {
    const exit = yield* Effect.exit(
      loadGatewayModuleBindings.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            ONTOS_GATEWAY_MODULE_BINDINGS: JSON.stringify([binding, { ...binding, sourceAppId: 'commerce-order-2' }]),
          }),
        ),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  }),
);
