import { ownerModuleCredentialConfigProvider } from '@app/core-runtime/auth/hosted-module-credentials';
import { assembleEffectBffRuntime } from '@modern-js/bff-effect/assembly';
import { Config, ConfigProvider, Effect, Redacted, Schema } from 'effect';
import type { Layer } from 'effect';
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from 'effect/http-api';
import { expect, it } from 'effect-rstest';

const CredentialApi = HttpApi.make('credential-probe').add(
  HttpApiGroup.make('probe').add(HttpApiEndpoint.get('credential', '/credential', { success: Schema.String })),
);

/** Reads the module credential per request, as the delegated gateway client does for every delegated call. */
const handlers = HttpApiBuilder.group(CredentialApi, 'probe', (group) =>
  group.handle('credential', () =>
    Config.String('ONTOS_GATEWAY_MODULE_API_KEY').pipe(Effect.orElseSucceed(() => 'missing')),
  ),
);

const hosted = new Map([
  ['commerce-customer-context', Redacted.make('commerce-customer-context-module-key')],
  ['pricing', Redacted.make('pricing-module-key-00000000')],
]);

const answerOf = (overlay: Layer.Layer<never>) =>
  Effect.gen(function* probeCredential() {
    const runtime = assembleEffectBffRuntime({ api: CredentialApi, handlers, transport: overlay });
    const web = yield* Effect.acquireRelease(
      Effect.sync(() => runtime.createHandler()),
      (handler) => Effect.promise(async () => await handler.dispose()),
    );
    const response = yield* Effect.promise(async () => await web.handler(new Request('http://owner.test/credential')));
    return yield* Effect.promise(async () => await response.text()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.String))),
    );
  }).pipe(Effect.scoped);

it.live("serves each owner's request handlers its own hosted module credential from the runtime overlay", () =>
  Effect.gen(function* ownerRequestsReadOwnCredential() {
    const environment = ConfigProvider.fromUnknown({ ONTOS_GATEWAY_MODULE_API_KEY: 'shared-environment-key' });
    const overlayOf = (appId: string) =>
      ConfigProvider.layer(ownerModuleCredentialConfigProvider(environment, appId, () => hosted));
    expect(yield* answerOf(overlayOf('commerce-customer-context'))).toBe('commerce-customer-context-module-key');
    expect(yield* answerOf(overlayOf('pricing'))).toBe('pricing-module-key-00000000');
    // An owner the host gave no credential has none; it never reads the shared environment's key.
    expect(yield* answerOf(overlayOf('catalog'))).toBe('missing');
  }),
);
