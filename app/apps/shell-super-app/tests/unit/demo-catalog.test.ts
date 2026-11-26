import { assert, expect, it } from 'effect-rstest';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { computeActionRequestHash } from '@app/core-runtime/actions/canonical-value-hash';
import { Effect, Option, Predicate, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import {
  SymmyDemoCategoriesBatchRequestSchema,
  SymmyDemoImageUrlSchema,
  SymmyDemoMediaUploadRequestSchema,
  SymmyDemoProductsBatchRequestSchema,
} from '../../api/symmy/demo-catalog-contract.ts';
import { symmyDemoCategoryId } from '../../api/symmy/demo-catalog-identity.ts';
import { readSymmyDemoCatalogRevision } from '../../api/symmy/demo-catalog-revision.ts';
import {
  executeSymmyDemoCategoriesBatch,
  executeSymmyDemoMediaUpload,
  executeSymmyDemoProductsBatch,
  symmyDemoCatalogOwnerOperation,
} from '../../api/symmy/demo-catalog.ts';
import type { SymmyDemoCatalogContext } from '../../api/symmy/demo-catalog.ts';
import type { SymmySourceReadScope } from '../../api/symmy/source-read-projections.ts';
import { ImportSourceCatalogPayloadSchema } from '@app/merchandise/contracts/import-source-catalog';
import { executeImportSourceCatalogWithAuthorization } from '@app/merchandise/apis/import-source-catalog-action/client';
import {
  ImportSourceCatalogActionAlreadyCommittedProblemSchema,
  ImportSourceCatalogActionCommitIndeterminateProblemSchema,
  ImportSourceCatalogActionConflictProblemSchema,
  ImportSourceCatalogActionForbiddenProblemSchema,
  ImportSourceCatalogActionUnavailableProblemSchema,
} from '@app/merchandise/apis/import-source-catalog-action';

const product = {
  active: true,
  category: 'New source category',
  lowStockThreshold: 0,
  name: 'An arbitrary newly imported product',
  priceMinor: 12_345,
  sku: 'SYMMY-NEW-987',
  stockTracked: false,
  taxClassificationCode: 'cz.vat.standard',
  unit: 'ks',
};
const sourceRequestDigest = 'a'.repeat(64);
const scope: SymmySourceReadScope = {
  allowedOwnerOperations: [],
  issuerId: 'issuer-one',
  legalEntityId: '22222222-2222-4222-8222-222222222222',
  mappingVersion: '1',
  routeId: 'products-route',
  routeRevision: '1',
  sourceNamespace: 'new-products',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

const context: SymmyDemoCatalogContext = {
  admission: {
    acquireOwnerAssertion: () =>
      Effect.succeed({
        apiBaseUrl: '/shell-super-app-api/module-api/merchandise/installed-release/merchandise-api',
        assertion: Redacted.make('fresh-company-assertion'),
        compositionRevision: 'a'.repeat(64),
      }),
    apiBaseUrl: '/unused-admission-base',
    assertion: Redacted.make('unused-admission-assertion'),
    compositionRevision: 'a'.repeat(64),
  },
  idempotencyKey: 'new-source-intent',
  newRequestIdentifier: Effect.succeed('catalog-unit-request'),
  scope: { ...scope, allowedOwnerOperations: [symmyDemoCatalogOwnerOperation] },
};

it('public import accepts an arbitrary new product, source category and HTTPS gallery', () => {
  const raw = {
    expectedRevision: 0,
    products: [{ ...product, categoryCode: 'never-preseeded-category', images: ['https://www.akros.cz/data/new.jpg'] }],
  };
  expect(
    Schema.encodeSync(SymmyDemoProductsBatchRequestSchema)(
      Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema)(raw),
    ),
  ).toEqual(raw);
  const categories = {
    categories: [
      { code: 'never-preseeded-category', name: 'New category', slug: 'new-category' },
      { code: 'child', name: 'Child category', parentCode: 'never-preseeded-category', slug: 'new-child' },
    ],
    expectedRevision: 0,
  };
  expect(
    Schema.encodeSync(SymmyDemoCategoriesBatchRequestSchema)(
      Schema.decodeUnknownSync(SymmyDemoCategoriesBatchRequestSchema)(categories),
    ),
  ).toEqual(categories);
});

it('gallery URL and batch bounds reject unsafe or oversized input before owner I/O', () => {
  for (const url of [
    'http://images.example.test/a.png',
    'https://user:password@images.example.test/a.png',
    'https://127.0.0.1/a.png',
    'https://[::1]/a.png',
    'https://localhost/a.png',
    'https://machine.local/a.png',
    'https://machine.internal/a.png',
    'https://images.example.test:444/a.png',
    'https://images.example.test/a.png#fragment',
    'data:image/png;base64,aGVsbG8=',
    'media:11111111-1111-4111-8111-111111111111',
    `https://images.example.test/${'x'.repeat(500)}`,
  ]) {
    assert.equal(Schema.is(SymmyDemoImageUrlSchema)(url), false, url);
  }
  assert.equal(Schema.is(SymmyDemoProductsBatchRequestSchema)({ expectedRevision: 0, products: [] }), false);
  assert.equal(
    Schema.is(SymmyDemoProductsBatchRequestSchema)({
      expectedRevision: 0,
      products: Array.from({ length: 17 }, () => product),
    }),
    false,
  );
  assert.equal(
    Schema.is(SymmyDemoProductsBatchRequestSchema)({
      expectedRevision: 0,
      products: [{ ...product, categoryCode: 'code', categoryId: 'native-id' }],
    }),
    false,
  );
});

it.effect('native source category ids are stable and isolate tenant, company, issuer, namespace and source route', () =>
  Effect.gen(function* categoryIdentity() {
    const id = yield* symmyDemoCategoryId(scope, 'source-category');
    assert.equal(yield* symmyDemoCategoryId(scope, 'source-category'), id);
    assert.ok(id.startsWith('symmy-'));
    assert.ok(id.length <= 300);
    for (const alternate of [
      { ...scope, tenantId: '33333333-3333-4333-8333-333333333333' },
      { ...scope, legalEntityId: '33333333-3333-4333-8333-333333333333' },
      { ...scope, issuerId: 'other-issuer' },
      { ...scope, sourceNamespace: 'other-namespace' },
      { ...scope, sourceRouteId: 'other-source-route' },
    ]) {
      assert.notEqual(yield* symmyDemoCategoryId(alternate, 'source-category'), id);
    }
    assert.notEqual(yield* symmyDemoCategoryId(scope, 'another-category'), id);
  }),
);

it('the dedicated owner action cannot mutate orders, prices, products or a saved gallery', () => {
  for (const command of [
    { _tag: 'ChangeOrderStatus', id: 'order', status: 'SHIPPED' },
    { _tag: 'ChangePrice', id: 'product', priceMinor: 1 },
    { _tag: 'UpdateProduct', id: 'product', patch: { name: 'Changed' } },
    { _tag: 'ChangeProductImages', change: { _tag: 'Set', images: [] }, id: 'product' },
    { _tag: 'ChangeProductImages', change: { _tag: 'Remove', image: 'media:asset' }, id: 'product' },
    { _tag: 'CreateProduct', ...product, images: ['media:another-products-asset'] },
  ]) {
    assert.equal(
      Schema.is(ImportSourceCatalogPayloadSchema)({ command, expectedRevision: 0, sourceRequestDigest }),
      false,
      command._tag,
    );
  }
  assert.equal(
    Schema.is(ImportSourceCatalogPayloadSchema)({
      command: { _tag: 'CreateProduct', ...product },
      expectedRevision: 0,
      sourceRequestDigest,
    }),
    true,
  );
});

it('the import action requires a SHA-256 source request digest', () => {
  const payload = { command: { _tag: 'CreateProduct', ...product }, expectedRevision: 0 };
  assert.equal(Schema.is(ImportSourceCatalogPayloadSchema)(payload), false);
  assert.equal(Schema.is(ImportSourceCatalogPayloadSchema)({ ...payload, sourceRequestDigest: 'not-a-digest' }), false);
});

it('image uploads retain CoreMedia rendition byte and dimension bounds', () => {
  const request = {
    expectedRevision: 0,
    image: { filename: 'photo.png', full: { contentBase64: 'iVBORw==' } },
    productId: 'native-product-id',
  };
  assert.equal(Schema.is(SymmyDemoMediaUploadRequestSchema)(request), true);
  assert.equal(
    Schema.is(SymmyDemoMediaUploadRequestSchema)({
      ...request,
      image: { ...request.image, full: { contentBase64: 'AAAA', width: 4097 } },
    }),
    false,
  );
  assert.equal(
    Schema.is(SymmyDemoMediaUploadRequestSchema)({
      ...request,
      image: { ...request.image, full: { contentBase64: 'A'.repeat(Math.ceil((5 * 1024 * 1024) / 3) * 4 + 4) } },
    }),
    false,
  );
});

it.effect('real owner client sends native creates with bearer, idempotency and composition headers', () =>
  Effect.gen(function* ownerRequest() {
    const calls: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ entityIds: ['native-product-id'], revision: 1 });
    };
    const payload = Schema.decodeUnknownSync(ImportSourceCatalogPayloadSchema)({
      command: { _tag: 'CreateProduct', ...product },
      expectedRevision: 0,
      sourceRequestDigest,
    });
    const result = yield* executeImportSourceCatalogWithAuthorization(
      payload,
      'Bearer fresh-owner-assertion',
      'catalog-import-test',
      {
        baseUrl: 'https://owner.example.test/merchandise-api',
        compositionRevision: 'a'.repeat(64),
        idempotencyKey: 'source-scoped-intent',
      },
    ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    assert.equal(calls.length, 1);
    const [request] = calls;
    assert.ok(request);
    assert.equal(request.url, 'https://owner.example.test/merchandise-api/merchandise/actions/import-source-catalog');
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('authorization'), 'Bearer fresh-owner-assertion');
    assert.equal(request.headers.get('idempotency-key'), 'source-scoped-intent');
    assert.equal(request.headers.get('x-ontos-composition-revision'), 'a'.repeat(64));
    assert.deepEqual(yield* Effect.promise(() => request.json()), payload);
    expect(result).toEqual({ entityIds: ['native-product-id'], revision: 1 });
  }),
);

it.effect('owner denial, already committed and uncertain commit stay failures, never fake completion', () =>
  Effect.gen(function* ownerRefusals() {
    const detail = {
      detail: 'Owner outcome',
      title: 'Owner outcome',
      type: 'https://ontos.dev/problems/owner-outcome',
    };
    const problems = [
      ImportSourceCatalogActionForbiddenProblemSchema.make({
        ...detail,
        code: 'action_permission_denied',
        status: 403,
      }),
      ImportSourceCatalogActionAlreadyCommittedProblemSchema.make({
        ...detail,
        code: 'action_already_committed',
        invocationId: 'owner-invocation',
        resolution: 'REFRESH_GOVERNED_READS',
        retryCommand: false,
        status: 409,
      }),
      ImportSourceCatalogActionCommitIndeterminateProblemSchema.make({
        ...detail,
        invocationId: 'owner-invocation',
        resolution: 'RESOLVE_COMMIT',
        retryCommand: false,
        status: 503,
      }),
    ];
    const payload = Schema.decodeUnknownSync(ImportSourceCatalogPayloadSchema)({
      command: { _tag: 'CreateProduct', ...product },
      expectedRevision: 0,
      sourceRequestDigest,
    });
    for (const problem of problems) {
      const fetch: typeof globalThis.fetch = async () =>
        Response.json(problem, { headers: { 'content-type': 'application/problem+json' }, status: problem.status });
      const error = yield* executeImportSourceCatalogWithAuthorization(
        payload,
        'Bearer denied',
        'catalog-import-test',
        {
          baseUrl: 'https://owner.example.test/merchandise-api',
          idempotencyKey: 'same-intent',
        },
      ).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fetch));
      assert.equal(Predicate.isTagged(error, problem._tag), true);
    }
  }),
);

it.effect(
  'public helpers create source categories, arbitrary products and bind native CoreMedia uploads in owner order',
  () =>
    Effect.gen(function* ownerWrites() {
      const calls: {
        command: typeof ImportSourceCatalogPayloadSchema.Type.command;
        expectedRevision: number;
        request: Request;
      }[] = [];
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const payload = Schema.decodeUnknownSync(ImportSourceCatalogPayloadSchema)(await request.json());
        calls.push({ ...payload, request });
        if (Predicate.isTagged(payload.command, 'CreateCategory')) {
          return Response.json({ entityIds: [payload.command.id], revision: calls.length });
        }
        if (Predicate.isTagged(payload.command, 'ChangeProductImages')) {
          return Response.json({
            entityIds: ['owner-created-product'],
            image: 'media:33333333-3333-4333-8333-333333333333',
            revision: calls.length,
          });
        }
        return Response.json({ entityIds: ['owner-created-product'], revision: calls.length });
      };
      const withOwnerFetch = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      const categories = yield* withOwnerFetch(
        executeSymmyDemoCategoriesBatch(
          context,
          Schema.decodeUnknownSync(SymmyDemoCategoriesBatchRequestSchema)({
            categories: [{ code: 'new', name: 'New category', slug: 'new-category' }],
            expectedRevision: 0,
          }),
        ),
      );
      const [created] = categories.items;
      assert.ok(created);
      const products = yield* withOwnerFetch(
        executeSymmyDemoProductsBatch(
          context,
          Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema)({
            expectedRevision: categories.revision,
            products: [{ ...product, categoryId: created.entityId }],
          }),
        ),
      );
      const uploaded = yield* withOwnerFetch(
        executeSymmyDemoMediaUpload(
          context,
          Schema.decodeUnknownSync(SymmyDemoMediaUploadRequestSchema)({
            expectedRevision: products.revision,
            image: { filename: 'new-product.png', full: { contentBase64: 'iVBORw==' } },
            productId: 'owner-created-product',
          }),
        ),
      );
      const [firstCall, secondCall, thirdCall] = calls;
      assert.equal(calls.length, 3);
      assert.equal(Predicate.isTagged(firstCall?.command, 'CreateCategory'), true);
      assert.equal(Predicate.isTagged(secondCall?.command, 'CreateProduct'), true);
      assert.equal(Predicate.isTagged(thirdCall?.command, 'ChangeProductImages'), true);
      assert.deepEqual(
        calls.map(({ expectedRevision }) => expectedRevision),
        [0, 1, 2],
      );
      const [categoryCall, productCall] = calls;
      assert.ok(Predicate.isTagged(categoryCall?.command, 'CreateCategory'));
      assert.ok(Predicate.isTagged(productCall?.command, 'CreateProduct'));
      assert.equal(productCall.command.categoryId, created.entityId);
      assert.equal(Option.isNone(categoryCall.command.parentId), true);
      for (const { request } of calls) {
        assert.equal(request.headers.get('authorization'), 'Bearer fresh-company-assertion');
        assert.equal(
          request.url,
          'https://symmy-owner-relay.invalid/module-api/merchandise/installed-release/merchandise-api/merchandise/actions/import-source-catalog',
        );
        assert.equal(request.headers.get('idempotency-key')?.length, 64);
      }
      assert.equal(new Set(calls.map(({ request }) => request.headers.get('idempotency-key'))).size, 3);
      assert.equal(uploaded.items[0]?.image, 'media:33333333-3333-4333-8333-333333333333');
      assert.equal(uploaded.legalEntityId, scope.legalEntityId);
      assert.equal(uploaded.tenantId, scope.tenantId);
    }),
);

for (const kind of ['categories', 'products'] as const) {
  it.effect(`${kind}: a partial batch resumes only for the original ordered request`, () =>
    Effect.gen(function* idempotentBatch() {
      const batch = (names: readonly string[], expectedRevision = 0, selected = context) =>
        kind === 'categories'
          ? executeSymmyDemoCategoriesBatch(
              selected,
              Schema.decodeUnknownSync(SymmyDemoCategoriesBatchRequestSchema)({
                categories: names.map((name) => ({ code: name, name, slug: name })),
                expectedRevision,
              }),
            )
          : executeSymmyDemoProductsBatch(
              selected,
              Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema)({
                expectedRevision,
                products: names.map((name) => ({ ...product, name, sku: name })),
              }),
            );
      const principal = Schema.decodeUnknownSync(
        TrustedPrincipalContextSchema.mapFields(({ legalEntityId, principalId, tenantId }) => ({
          legalEntityId,
          principalId,
          tenantId,
        })),
      )({ ...scope, principalId: '33333333-3333-4333-8333-333333333333' });

      // Capture identities after the real HTTP client and the published owner payload codec.
      // Stand in only for receipt storage/transport, not for the Action's request hash.
      interface Receipt {
        entityIds: string[];
        revision: number;
      }
      const attempts: { hash: string; key: string; revision: number }[] = [];
      const receipts = new Map<string, Receipt>();
      let interruptSecond = true;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        const payload = Schema.decodeUnknownSync(ImportSourceCatalogPayloadSchema)(await request.json());
        const hash = computeActionRequestHash({
          actionKey: 'demo.merchandise.import-source-catalog',
          normalizedPayload: Schema.encodeSync(ImportSourceCatalogPayloadSchema)(payload),
          owningModuleKey: 'demo.merchandise',
          principal,
          schemaVersion: '1',
          target: {},
        });
        const key = request.headers.get('idempotency-key');
        assert.ok(key !== null && key.length > 0);
        const previous = attempts.find((attempt) => attempt.key === key);
        attempts.push({ hash, key, revision: payload.expectedRevision });
        if (previous !== undefined && previous.hash !== hash) {
          return Response.json(
            ImportSourceCatalogActionConflictProblemSchema.make({
              code: 'action_request_hash_conflict',
              detail: 'Request changed',
              status: 409,
              title: 'Conflict',
              type: 'https://ontos.dev/problems/action-request-hash-conflict',
            }),
            { headers: { 'content-type': 'application/problem+json' }, status: 409 },
          );
        }
        const saved = receipts.get(key);
        if (saved !== undefined) {
          return Response.json(saved);
        }
        if (payload.expectedRevision === 1 && interruptSecond) {
          interruptSecond = false;
          return Response.json(
            ImportSourceCatalogActionUnavailableProblemSchema.make({
              code: 'operation_context_unavailable',
              detail: 'Try again',
              retryable: true,
              status: 503,
              title: 'Unavailable',
              type: 'https://ontos.dev/problems/operation-context-unavailable',
            }),
            { headers: { 'content-type': 'application/problem+json' }, status: 503 },
          );
        }
        assert.equal(payload.expectedRevision, receipts.size);
        const { command } = payload;
        const receipt = {
          entityIds: [Predicate.isTagged(command, 'CreateCategory') ? command.id : `product-${receipts.size}`],
          revision: receipts.size + 1,
        };
        receipts.set(key, receipt);
        return Response.json(receipt);
      };
      const withOwnerFetch = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      const original = ['alpha', 'beta', 'gamma'];
      const failure = yield* withOwnerFetch(batch(original).pipe(Effect.flip));
      assert.equal(Predicate.isTagged(failure, 'ImportSourceCatalogActionUnavailableProblem'), true);
      assert.equal(receipts.size, 1);
      const [first, interrupted] = attempts;
      assert.ok(first !== undefined && interrupted !== undefined && first.key !== interrupted.key);
      for (const changed of [
        original.slice(0, 1),
        [...original, 'delta'],
        ['alpha', 'gamma', 'beta'],
        ['alpha', 'edited', 'gamma'],
      ]) {
        const start = attempts.length;
        const conflict = yield* withOwnerFetch(batch(changed).pipe(Effect.flip));
        assert.equal(Predicate.isTagged(conflict, 'ImportSourceCatalogActionConflictProblem'), true);
        assert.equal(attempts.length, start + 1);
        assert.equal(attempts[start]?.key, first.key);
        assert.notEqual(attempts[start]?.hash, first.hash);
        assert.equal(receipts.size, 1);
      }
      const start = attempts.length;
      const result = yield* withOwnerFetch(batch(original));
      assert.deepEqual(attempts.slice(start, start + 2), [first, interrupted]);
      assert.deepEqual(
        result.items.map(({ entityId, revision }) => [entityId, revision]),
        [...receipts.values()].map(({ entityIds, revision }) => [entityIds[0], revision]),
      );
      assert.equal(result.revision, 3);
      assert.equal(receipts.size, 3);

      // Original incident: extending even a fully successful one-item batch cannot append a write.
      const singleton = { ...context, idempotencyKey: 'completed-singleton' };
      yield* withOwnerFetch(batch(['delta'], 3, singleton));
      const startExtension = attempts.length;
      const extension = yield* withOwnerFetch(batch(['delta', 'epsilon'], 3, singleton).pipe(Effect.flip));
      assert.equal(Predicate.isTagged(extension, 'ImportSourceCatalogActionConflictProblem'), true);
      assert.equal(attempts.length, startExtension + 1);
      assert.equal(receipts.size, 4);
    }),
  );
}

it.effect('missing company or owner enrollment is refused before obtaining any assertion', () =>
  Effect.gen(function* forbiddenScope() {
    let attempts = 0;
    const request = Schema.decodeUnknownSync(SymmyDemoCategoriesBatchRequestSchema)({
      categories: [{ code: 'new', name: 'New', slug: 'new' }],
      expectedRevision: 0,
    });
    const { legalEntityId: _unselected, ...withoutCompany } = context.scope;
    const acquireOwnerAssertion = () => {
      attempts += 1;
      return Effect.die('Unexpected assertion attempt');
    };
    for (const selected of [scope, withoutCompany]) {
      // The issuer callback is deliberately a defect if reached; a fail-closed branch must not invoke it.
      const deniedContext = {
        ...context,
        admission: {
          ...context.admission,
          acquireOwnerAssertion,
        },
        scope: selected,
      };
      const error = yield* executeSymmyDemoCategoriesBatch(deniedContext, request).pipe(Effect.flip);
      assert.equal(Predicate.isTagged(error, 'GatewayForbiddenProblem'), true);
    }
    assert.equal(attempts, 0);
  }),
);

it.effect('preflight rejects category cycles, foreign native ids and unconfigured image hosts without a write', () =>
  Effect.gen(function* preflightValidation() {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return Response.json({});
    };
    const cycle = Schema.decodeUnknownSync(SymmyDemoCategoriesBatchRequestSchema)({
      categories: [
        { code: 'parent', name: 'Parent', parentCode: 'child', slug: 'parent' },
        { code: 'child', name: 'Child', parentCode: 'parent', slug: 'child' },
      ],
      expectedRevision: 0,
    });
    const cycleError = yield* executeSymmyDemoCategoriesBatch(context, cycle).pipe(
      Effect.flip,
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    assert.equal(Predicate.isTagged(cycleError, 'SymmyInvalidProblem'), true);
    for (const extra of [
      { categoryId: yield* symmyDemoCategoryId({ ...scope, issuerId: 'foreign' }, 'new') },
      { images: ['https://unconfigured-image-host.example.test/new.png'] },
    ]) {
      const request = Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema)({
        expectedRevision: 0,
        products: [{ ...product, ...extra }],
      });
      const error = yield* executeSymmyDemoProductsBatch(context, request).pipe(
        Effect.flip,
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
      assert.ok(
        Predicate.isTagged(error, 'GatewayForbiddenProblem') || Predicate.isTagged(error, 'SymmyInvalidProblem'),
      );
    }
    assert.equal(calls, 0);
  }),
);

it.effect('a changed composition is refused before native transport and uncertain native writes remain uncertain', () =>
  Effect.gen(function* changedComposition() {
    let calls = 0;
    const problem = ImportSourceCatalogActionCommitIndeterminateProblemSchema.make({
      detail: 'Resolve the owner invocation before retrying',
      invocationId: 'uncertain-owner-invocation',
      resolution: 'RESOLVE_COMMIT',
      retryCommand: false,
      status: 503,
      title: 'Commit uncertain',
      type: 'https://ontos.dev/problems/action-commit-indeterminate',
    });
    const fetch: typeof globalThis.fetch = async () => {
      calls += 1;
      return Response.json(problem, { headers: { 'content-type': 'application/problem+json' }, status: 503 });
    };
    const request = Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema)({
      expectedRevision: 0,
      products: [product],
    });
    const changed = {
      ...context,
      admission: { ...context.admission, compositionRevision: 'b'.repeat(64) },
    };
    const staleError = yield* executeSymmyDemoProductsBatch(changed, request).pipe(
      Effect.flip,
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    assert.equal(Predicate.isTagged(staleError, 'SymmyUnavailableProblem'), true);
    assert.equal(calls, 0);
    const uncertain = yield* executeSymmyDemoProductsBatch(context, request).pipe(
      Effect.flip,
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    );
    assert.equal(Predicate.isTagged(uncertain, 'ImportSourceCatalogActionCommitIndeterminateProblem'), true);
    assert.ok('retryCommand' in uncertain);
    assert.equal(uncertain.retryCommand, false);
    assert.equal(calls, 1);
  }),
);

it.effect('revision read returns actual company metadata with fresh authorization and no idempotency requirement', () =>
  Effect.gen(function* revisionRequest() {
    const calls: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json({ legalEntityId: scope.legalEntityId, revision: 471, tenantId: scope.tenantId });
    };
    const result = yield* readSymmyDemoCatalogRevision({
      admission: context.admission,
      newRequestIdentifier: context.newRequestIdentifier,
      scope: context.scope,
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
    assert.deepEqual(result, { legalEntityId: scope.legalEntityId, revision: 471, tenantId: scope.tenantId });
    const [request] = calls;
    assert.ok(request);
    assert.equal(
      request.url,
      'https://symmy-owner-relay.invalid/module-api/merchandise/installed-release/merchandise-api/reads/demo-catalog-revision',
    );
    assert.equal(request.headers.get('authorization'), 'Bearer fresh-company-assertion');
    assert.equal(request.headers.get('idempotency-key'), null);
    assert.equal(request.headers.get('cache-control'), 'no-store');
    assert.deepEqual(yield* Effect.promise(() => request.json()), {});
  }),
);

const foreignRevisionFetch: typeof globalThis.fetch = () =>
  Promise.resolve(
    Response.json({
      legalEntityId: '33333333-3333-4333-8333-333333333333',
      revision: 471,
      tenantId: scope.tenantId,
    }),
  );

it.effect('revision snapshots cannot cross the enrolled company boundary', () =>
  Effect.gen(function* revisionScope() {
    const error = yield* readSymmyDemoCatalogRevision(context).pipe(
      Effect.flip,
      Effect.provideService(FetchHttpClient.Fetch, foreignRevisionFetch),
    );
    assert.equal(Predicate.isTagged(error, 'SymmyUnavailableProblem'), true);
  }),
);
