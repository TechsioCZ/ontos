import { Effect, Predicate, Redacted, Schema } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { asInvoiceLines, expectedTotals, makePrincipalClient } from '../demo/prove-sales-demo.mts';

const compositionRevision = 'composition-1';
const gatewayPath = '/gateway-context';
const ownerApi = '/owner-api';
const shellUrl = 'http://demo.test';
const principal = () =>
  makePrincipalClient(shellUrl, Redacted.make('fixture')).bot(Redacted.make('fixture-key'), compositionRevision);

it('retains product snapshots and rounds VAT independently per line', () => {
  const lines = [
    { productId: 'product-1', productName: 'First', quantity: 1, unitPriceMinor: 101, vatRate: 21 },
    { productName: 'Second', quantity: 1, unitPriceMinor: 102, vatRate: 21 },
  ];
  expect(asInvoiceLines(lines)).toEqual([
    { description: 'First', productId: 'product-1', quantity: 1, unitPriceMinor: 101, vatRate: 21 },
    { description: 'Second', quantity: 1, unitPriceMinor: 102, vatRate: 21 },
  ]);
  expect(expectedTotals(lines)).toEqual({ subtotalMinor: 203, totalMinor: 245, vatMinor: 42 });
});

it.effect('issues a fresh assertion for every owner call and preserves composition headers', () =>
  Effect.gen(function* freshAssertions() {
    let assertions = 0;
    const authorizations: string[] = [];
    const client = HttpClient.make((request, url) => {
      if (url.pathname.endsWith(gatewayPath)) {
        assertions += 1;
        expect(request.headers['x-api-key']).toBe('fixture-key');
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              apiBaseUrl: ownerApi,
              compositionRevision,
              token: `assertion-${assertions}`,
            }),
          ),
        );
      }
      authorizations.push(request.headers.authorization ?? 'missing');
      expect(request.headers['x-ontos-composition-revision']).toBe(compositionRevision);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ revision: 1 })));
    });
    yield* Effect.gen(function* ownerReads() {
      yield* principal().records('merchandise', Schema.Struct({ revision: Schema.Number }));
      yield* principal().records('merchandise', Schema.Struct({ revision: Schema.Number }));
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(authorizations).toEqual(['Bearer assertion-1', 'Bearer assertion-2']);
  }),
);

it.effect('re-reads revision and uses a new invocation key after a revision conflict', () =>
  Effect.gen(function* revisionRetry() {
    let reads = 0;
    const keys: string[] = [];
    const client = HttpClient.make((request, url) => {
      if (url.pathname.endsWith(gatewayPath)) {
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              apiBaseUrl: ownerApi,
              compositionRevision,
              token: 'fixture-assertion',
            }),
          ),
        );
      }
      if (url.pathname.endsWith('/reads/records')) {
        reads += 1;
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ revision: reads })));
      }
      keys.push(request.headers['idempotency-key'] ?? 'missing');
      const response =
        keys.length === 1
          ? Response.json({ code: 'revision_conflict' }, { status: 409 })
          : Response.json({ changed: true });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    });
    const result = yield* principal()
      .apply('tagging', { _tag: 'DeleteTag', id: 'tag-1' })
      .pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(result.status).toBe(200);
    expect(reads).toBe(2);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  }),
);

it.effect('returns a denied gateway response without invoking an owner', () =>
  Effect.gen(function* deniedGateway() {
    const paths: string[] = [];
    const client = HttpClient.make((request, url) => {
      paths.push(url.pathname);
      return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ code: 'denied' }, { status: 403 })));
    });
    const response = yield* principal().read('merchandise').pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(response.status).toBe(403);
    expect(paths).toEqual(['/shell-super-app-api/auth/api-key/gateway-context']);
  }),
);

it.effect('rejects malformed successful owner data instead of asserting its wire type', () =>
  Effect.gen(function* malformedOwnerData() {
    const client = HttpClient.make((request, url) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          url.pathname.endsWith(gatewayPath)
            ? Response.json({
                apiBaseUrl: ownerApi,
                compositionRevision,
                token: 'fixture-assertion',
              })
            : Response.json({ revision: 'invalid' }),
        ),
      ),
    );
    const failure = yield* principal()
      .records('merchandise', Schema.Struct({ revision: Schema.Number }))
      .pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);
    expect(Predicate.isTagged(failure, 'SchemaError')).toBe(true);
  }),
);
