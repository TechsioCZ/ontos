import { ConfigProvider, Effect, Layer } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import { CommerceUnitTransportLive } from '../../api/unit-transport.ts';

const transportWith = (environment: Readonly<Record<string, string>>) =>
  FetchHttpClient.Fetch.pipe(
    Effect.provide(
      CommerceUnitTransportLive.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(environment)))),
    ),
  );

it.effect('keeps the runtime fetch on Node, where units are reached at their URLs', () =>
  Effect.gen(function* keepsRuntimeFetchOnNode() {
    expect(
      yield* transportWith({
        ONTOS_PRICE_GROUP_CATALOG_BASE_URL: 'https://price-group-catalog.test/price-group-catalog-api',
      }),
    ).toBe(globalThis.fetch);
  }),
);

it.effect('leaves a malformed catalog URL to the Price Group Catalog port instead of failing every route', () =>
  Effect.gen(function* leavesMalformedUrlToThePort() {
    expect(yield* transportWith({ ONTOS_PRICE_GROUP_CATALOG_BASE_URL: 'not a url' })).toBe(globalThis.fetch);
  }),
);
