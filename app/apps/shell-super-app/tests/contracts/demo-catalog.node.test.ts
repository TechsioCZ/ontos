import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Effect, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import {
  SymmyDemoCategoriesBatchRequestSchema,
  SymmyDemoImageUrlSchema,
  SymmyDemoMediaUploadRequestSchema,
  SymmyDemoProductsBatchRequestSchema,
} from '../../api/symmy/demo-catalog-contract.ts';
import { symmyDemoCategoryId } from '../../api/symmy/demo-catalog-identity.ts';
import { readSymmyDemoCatalogRevision } from '../../api/symmy/demo-catalog-revision.ts';
import { merchandiseApi } from '../../../../verticals/merchandise/shared/api.ts';
import { importSourceCatalogAction } from '../../../../verticals/merchandise/src/actions/import-source-catalog.action.ts';
import { demoCatalogRevisionRead } from '../../../../verticals/merchandise/src/api/demo-catalog-revision.read.ts';
import { SYMMY_DEMO_CATALOG_IMPORT_WORKLOAD } from '../../../../verticals/merchandise/shared/apis/demo-catalog-revision.ts';
import {
  executeSymmyDemoCategoriesBatch,
  executeSymmyDemoMediaUpload,
  executeSymmyDemoProductsBatch,
  symmyDemoCatalogOwnerOperation,
} from '../../api/symmy/demo-catalog.ts';
import type { SymmyDemoCatalogContext } from '../../api/symmy/demo-catalog.ts';
import type { SymmySourceReadScope } from '../../api/symmy/source-read-projections.ts';
import { ImportSourceCatalogPayloadSchema } from '../../../../verticals/merchandise/shared/actions/import-source-catalog.ts';
import { executeImportSourceCatalogWithAuthorization } from '../../../../verticals/merchandise/src/api/import-source-catalog-action-client.ts';
import {
  ImportSourceCatalogActionAlreadyCommittedProblemSchema,
  ImportSourceCatalogActionCommitIndeterminateProblemSchema,
  ImportSourceCatalogActionForbiddenProblemSchema,
} from '../../../../verticals/merchandise/shared/apis/import-source-catalog-action.ts';

const product = {
  active: true,
  category: 'New source category',
  lowStockThreshold: 0,
  name: 'An arbitrary newly imported product',
  priceMinor: 12345,
  sku: 'SYMMY-NEW-987',
  stockTracked: false,
  taxClassificationCode: 'cz.vat.standard',
  unit: 'ks',
};
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

test('public import accepts an arbitrary new product, source category and HTTPS gallery', () => {
  const raw = {
    expectedRevision: 0,
    products: [{ ...product, categoryCode: 'never-preseeded-category', images: ['https://www.akros.cz/data/new.jpg'] }],
  };
  assert.deepEqual(Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema)(raw), raw);
  const categories = {
    categories: [
      { code: 'never-preseeded-category', name: 'New category', slug: 'new-category' },
      { code: 'child', name: 'Child category', parentCode: 'never-preseeded-category', slug: 'new-child' },
    ],
    expectedRevision: 0,
  };
  assert.deepEqual(Schema.decodeUnknownSync(SymmyDemoCategoriesBatchRequestSchema)(categories), categories);
});

test('gallery URL and batch bounds reject unsafe or oversized input before owner I/O', () => {
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
    Schema.is(SymmyDemoProductsBatchRequestSchema)({ expectedRevision: 0, products: Array(17).fill(product) }),
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

test('native source category ids are stable and isolate tenant, company, issuer, namespace and source route', async () => {
  const id = await Effect.runPromise(symmyDemoCategoryId(scope, 'source-category'));
  assert.equal(await Effect.runPromise(symmyDemoCategoryId(scope, 'source-category')), id);
  assert.ok(id.startsWith('symmy-'));
  assert.ok(id.length <= 300);
  for (const alternate of [
    { ...scope, tenantId: '33333333-3333-4333-8333-333333333333' },
    { ...scope, legalEntityId: '33333333-3333-4333-8333-333333333333' },
    { ...scope, issuerId: 'other-issuer' },
    { ...scope, sourceNamespace: 'other-namespace' },
    { ...scope, sourceRouteId: 'other-source-route' },
  ]) {
    assert.notEqual(await Effect.runPromise(symmyDemoCategoryId(alternate, 'source-category')), id);
  }
  assert.notEqual(await Effect.runPromise(symmyDemoCategoryId(scope, 'another-category')), id);
});

test('the dedicated owner action cannot mutate orders, prices, products or a saved gallery', () => {
  for (const command of [
    { _tag: 'ChangeOrderStatus', id: 'order', status: 'SHIPPED' },
    { _tag: 'ChangePrice', id: 'product', priceMinor: 1 },
    { _tag: 'UpdateProduct', id: 'product', patch: { name: 'Changed' } },
    { _tag: 'ChangeProductImages', id: 'product', change: { _tag: 'Set', images: [] } },
    { _tag: 'ChangeProductImages', id: 'product', change: { _tag: 'Remove', image: 'media:asset' } },
    { _tag: 'CreateProduct', ...product, images: ['media:another-products-asset'] },
  ]) {
    assert.equal(Schema.is(ImportSourceCatalogPayloadSchema)({ command, expectedRevision: 0 }), false, command._tag);
  }
  assert.equal(
    Schema.is(ImportSourceCatalogPayloadSchema)({
      command: { _tag: 'CreateProduct', ...product },
      expectedRevision: 0,
    }),
    true,
  );
});

test('image uploads retain CoreMedia rendition byte and dimension bounds', () => {
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

test('real owner client sends native creates with bearer, idempotency and composition headers', async () => {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(new Request(input, init));
    return Response.json({ entityIds: ['native-product-id'], revision: 1 });
  };
  const payload = Schema.decodeUnknownSync(ImportSourceCatalogPayloadSchema)({
    command: { _tag: 'CreateProduct', ...product },
    expectedRevision: 0,
  });
  const result = await Effect.runPromise(
    executeImportSourceCatalogWithAuthorization(payload, 'Bearer fresh-owner-assertion', 'catalog-import-test', {
      baseUrl: 'https://owner.example.test/merchandise-api',
      compositionRevision: 'a'.repeat(64),
      idempotencyKey: 'source-scoped-intent',
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
  );
  assert.equal(calls.length, 1);
  const [request] = calls;
  assert.ok(request);
  assert.equal(request.url, 'https://owner.example.test/merchandise-api/merchandise/actions/import-source-catalog');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('authorization'), 'Bearer fresh-owner-assertion');
  assert.equal(request.headers.get('idempotency-key'), 'source-scoped-intent');
  assert.equal(request.headers.get('x-ontos-composition-revision'), 'a'.repeat(64));
  assert.deepEqual(await request.json(), payload);
  assert.deepEqual(result, { entityIds: ['native-product-id'], revision: 1 });
});

test('owner denial, already committed and uncertain commit stay failures, never fake completion', async () => {
  const detail = { detail: 'Owner outcome', title: 'Owner outcome', type: 'https://ontos.dev/problems/owner-outcome' };
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
  });
  for (const problem of problems) {
    const fetch: typeof globalThis.fetch = async () =>
      Response.json(problem, { status: problem.status, headers: { 'content-type': 'application/problem+json' } });
    const error = await Effect.runPromise(
      executeImportSourceCatalogWithAuthorization(payload, 'Bearer denied', 'catalog-import-test', {
        baseUrl: 'https://owner.example.test/merchandise-api',
        idempotencyKey: 'same-intent',
      }).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fetch)),
    );
    assert.equal(error._tag, problem._tag);
  }
});

test('public helpers create source categories, arbitrary products and bind native CoreMedia uploads in owner order', async () => {
  const calls: { command: Record<string, unknown>; expectedRevision: number; request: Request }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const payload = Schema.decodeUnknownSync(Schema.toEncoded(ImportSourceCatalogPayloadSchema))(await request.json());
    calls.push({ ...payload, request });
    if (payload.command._tag === 'CreateCategory') {
      return Response.json({ entityIds: [payload.command.id], revision: calls.length });
    }
    if (payload.command._tag === 'ChangeProductImages') {
      return Response.json({
        entityIds: ['owner-created-product'],
        image: 'media:33333333-3333-4333-8333-333333333333',
        revision: calls.length,
      });
    }
    return Response.json({ entityIds: ['owner-created-product'], revision: calls.length });
  };
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)));
  const categories = await run(
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
  const products = await run(
    executeSymmyDemoProductsBatch(
      context,
      Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema)({
        expectedRevision: categories.revision,
        products: [{ ...product, categoryId: created.entityId }],
      }),
    ),
  );
  const uploaded = await run(
    executeSymmyDemoMediaUpload(
      context,
      Schema.decodeUnknownSync(SymmyDemoMediaUploadRequestSchema)({
        expectedRevision: products.revision,
        image: { filename: 'new-product.png', full: { contentBase64: 'iVBORw==' } },
        productId: 'owner-created-product',
      }),
    ),
  );
  assert.deepEqual(
    calls.map(({ command }) => command._tag),
    ['CreateCategory', 'CreateProduct', 'ChangeProductImages'],
  );
  assert.deepEqual(
    calls.map(({ expectedRevision }) => expectedRevision),
    [0, 1, 2],
  );
  assert.equal(calls[1]?.command.categoryId, created.entityId);
  assert.equal(calls[0]?.command.parentId, null);
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
});

test('missing company or owner enrollment is refused before obtaining any assertion', async () => {
  let attempts = 0;
  const request = Schema.decodeUnknownSync(SymmyDemoCategoriesBatchRequestSchema)({
    categories: [{ code: 'new', name: 'New', slug: 'new' }],
    expectedRevision: 0,
  });
  for (const selected of [
    { ...context, scope },
    { ...context, scope: { ...context.scope, legalEntityId: undefined } },
  ]) {
    // The issuer callback is deliberately a defect if reached; a fail-closed branch must not invoke it.
    const deniedContext = {
      ...selected,
      admission: {
        ...context.admission,
        acquireOwnerAssertion: () => {
          attempts += 1;
          return Effect.die('Unexpected assertion attempt');
        },
      },
    };
    const error = await Effect.runPromise(executeSymmyDemoCategoriesBatch(deniedContext, request).pipe(Effect.flip));
    assert.equal(error._tag, 'GatewayForbiddenProblem');
  }
  assert.equal(attempts, 0);
});

test('preflight rejects category cycles, foreign native ids and unconfigured image hosts without a write', async () => {
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
  const cycleError = await Effect.runPromise(
    executeSymmyDemoCategoriesBatch(context, cycle).pipe(
      Effect.flip,
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  assert.equal(cycleError._tag, 'SymmyInvalidProblem');
  for (const extra of [
    { categoryId: await Effect.runPromise(symmyDemoCategoryId({ ...scope, issuerId: 'foreign' }, 'new')) },
    { images: ['https://unconfigured-image-host.example.test/new.png'] },
  ]) {
    const request = Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema)({
      expectedRevision: 0,
      products: [{ ...product, ...extra }],
    });
    const error = await Effect.runPromise(
      executeSymmyDemoProductsBatch(context, request).pipe(
        Effect.flip,
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );
    assert.ok(error._tag === 'GatewayForbiddenProblem' || error._tag === 'SymmyInvalidProblem');
  }
  assert.equal(calls, 0);
});

test('a changed composition is refused before native transport and uncertain native writes remain uncertain', async () => {
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
    return Response.json(problem, { status: 503, headers: { 'content-type': 'application/problem+json' } });
  };
  const request = Schema.decodeUnknownSync(SymmyDemoProductsBatchRequestSchema)({
    expectedRevision: 0,
    products: [product],
  });
  const changed = {
    ...context,
    admission: { ...context.admission, compositionRevision: 'b'.repeat(64) },
  };
  const staleError = await Effect.runPromise(
    executeSymmyDemoProductsBatch(changed, request).pipe(
      Effect.flip,
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  assert.equal(staleError._tag, 'SymmyUnavailableProblem');
  assert.equal(calls, 0);
  const uncertain = await Effect.runPromise(
    executeSymmyDemoProductsBatch(context, request).pipe(
      Effect.flip,
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  );
  assert.equal(uncertain._tag, 'ImportSourceCatalogActionCommitIndeterminateProblem');
  assert.ok('retryCommand' in uncertain);
  assert.equal(uncertain.retryCommand, false);
  assert.equal(calls, 1);
});

test('owner API mounts both import and revision with a company-bound machine workload carrier', () => {
  assert.ok(merchandiseApi.groups.importSourceCatalogAction);
  assert.ok(merchandiseApi.groups.demoCatalogRevision);
  assert.ok(merchandiseApi.groups.demoOrderExport);
  assert.equal(importSourceCatalogAction.descriptor.legalEntityScope, 'required');
  assert.equal(demoCatalogRevisionRead.descriptor.legalEntityScope, 'required');
  assert.deepEqual(importSourceCatalogAction.descriptor.accessWorkload?.workloads, [
    SYMMY_DEMO_CATALOG_IMPORT_WORKLOAD,
  ]);
  assert.deepEqual(demoCatalogRevisionRead.descriptor.accessWorkload?.workloads, [SYMMY_DEMO_CATALOG_IMPORT_WORKLOAD]);
  assert.equal(SYMMY_DEMO_CATALOG_IMPORT_WORKLOAD, 'demo.merchandise.symmy-catalog-import');
});

test('revision read returns actual company metadata with fresh authorization and no idempotency requirement', async () => {
  const calls: Request[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(new Request(input, init));
    return Response.json({ legalEntityId: scope.legalEntityId, revision: 471, tenantId: scope.tenantId });
  };
  const result = await Effect.runPromise(
    readSymmyDemoCatalogRevision({
      admission: context.admission,
      newRequestIdentifier: context.newRequestIdentifier,
      scope: context.scope,
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch)),
  );
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
  assert.deepEqual(await request.json(), {});
});

test('revision snapshots cannot cross the enrolled company boundary', async () => {
  const fetch: typeof globalThis.fetch = async () =>
    Response.json({
      legalEntityId: '33333333-3333-4333-8333-333333333333',
      revision: 471,
      tenantId: scope.tenantId,
    });
  const error = await Effect.runPromise(
    readSymmyDemoCatalogRevision(context).pipe(Effect.flip, Effect.provideService(FetchHttpClient.Fetch, fetch)),
  );
  assert.equal(error._tag, 'SymmyUnavailableProblem');
});
