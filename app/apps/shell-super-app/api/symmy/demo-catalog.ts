import { computeCanonicalValueHash } from '@app/core-runtime/access/enforcement';
import { executeImportSourceCatalogWithAuthorization } from '@app/merchandise/apis/import-source-catalog-action/client';
import { importSourceCatalogActionErrors } from '@app/merchandise/apis/import-source-catalog-action';
import {
  ImportSourceCatalogPayloadSchema,
  isMediaImageReference,
} from '@app/merchandise/contracts/import-source-catalog';
import type { ImportSourceCatalogPayload } from '@app/merchandise/contracts/import-source-catalog';
import { GatewayForbiddenProblemSchema } from '@app/shared-contracts';
import { Effect, Redacted, Schema } from 'effect';
import { symmyInvalidProblem, symmyUnavailableProblem } from './contract.ts';
import type { SymmyIngressProblem } from './contract.ts';
import type {
  SymmyDemoCategoriesBatchRequest,
  SymmyDemoMediaUploadRequest,
  SymmyDemoProductsBatchRequest,
} from './demo-catalog-contract.ts';
import type { SymmySourceReadScope } from './source-read-projections.ts';
import type { SymmyIngressAdmission } from './transport.ts';
import { resolveSymmyOwnerReleaseBase } from './owner-release-transport.ts';
import {
  symmyDemoCatalogDigest as digest,
  symmyDemoCatalogScopeIdentity as scopeIdentity,
  symmyDemoCategoryId,
  symmyDemoCategoryPrefix,
} from './demo-catalog-identity.ts';
export { symmyDemoCategoryId } from './demo-catalog-identity.ts';
export { importSourceCatalogActionErrors } from '@app/merchandise/apis/import-source-catalog-action';

const ownerProblemSchema = Schema.Union(importSourceCatalogActionErrors);
const isOwnerProblem = Schema.is(ownerProblemSchema);

export const symmyDemoCatalogOwnerOperation = {
  entrypointKey: 'demo.merchandise.import-source-catalog',
  moduleId: 'demo.merchandise',
  schemaVersion: '1',
} as const;

const forbidden = GatewayForbiddenProblemSchema.make({
  detail: 'The current integration route cannot import this company catalog.',
  status: 403,
  title: 'Catalog import forbidden',
  type: 'https://ontos.dev/problems/gateway-forbidden',
});

export interface SymmyDemoCatalogContext {
  readonly admission: SymmyIngressAdmission;
  readonly idempotencyKey: string;
  /** Server-owned list matching STOREFRONT_IMAGE_HOSTS. CoreMedia uploads do not depend on an external host. */
  readonly imageHosts?: readonly string[];
  readonly newRequestIdentifier: Effect.Effect<string, typeof symmyUnavailableProblem>;
  readonly scope: SymmySourceReadScope;
}

const requireScope = (context: SymmyDemoCatalogContext) =>
  context.scope.legalEntityId !== undefined &&
  context.idempotencyKey.length > 0 &&
  context.idempotencyKey.length <= 200 &&
  context.scope.allowedOwnerOperations.some(
    ({ entrypointKey, moduleId, schemaVersion }) =>
      entrypointKey === symmyDemoCatalogOwnerOperation.entrypointKey &&
      moduleId === symmyDemoCatalogOwnerOperation.moduleId &&
      schemaVersion === '1',
  )
    ? Effect.succeed(context.scope.legalEntityId)
    : Effect.fail(forbidden);

/** Every attempt acquires a fresh audience/company assertion and retains the owner's typed recovery failures. */
const write = Effect.fn('SymmyDemoCatalog.write')(function* write(
  context: SymmyDemoCatalogContext,
  payload: ImportSourceCatalogPayload,
  itemKey: string,
) {
  const company = yield* requireScope(context);
  if (context.admission.acquireOwnerAssertion === undefined) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const assertion = yield* context.admission.acquireOwnerAssertion({ audience: 'merchandise', legalEntityId: company });
  if (assertion.compositionRevision !== context.admission.compositionRevision) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  const baseUrl = yield* resolveSymmyOwnerReleaseBase(assertion.apiBaseUrl, 'merchandise');
  const idempotencyKey = yield* digest(JSON.stringify([scopeIdentity(context.scope), context.idempotencyKey, itemKey]));
  const result = yield* executeImportSourceCatalogWithAuthorization(
    payload,
    `Bearer ${Redacted.value(assertion.assertion)}`,
    yield* context.newRequestIdentifier,
    { baseUrl, compositionRevision: assertion.compositionRevision, idempotencyKey },
  ).pipe(Effect.mapError((error) => (isOwnerProblem(error) ? error : symmyUnavailableProblem)));
  if (!('entityIds' in result)) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  return result;
});

const decodeCommand = (command: unknown, expectedRevision: number, sourceRequestDigest: string) =>
  Schema.decodeUnknownEffect(ImportSourceCatalogPayloadSchema)({ command, expectedRevision, sourceRequestDigest }).pipe(
    Effect.mapError(() => symmyInvalidProblem),
  );

type Applied = {
  readonly entityId: string;
  readonly image?: string;
  readonly index: number;
  readonly outcome: 'APPLIED';
  readonly revision: number;
};

const response = (context: SymmyDemoCatalogContext, company: string, items: readonly Applied[], revision: number) => ({
  items,
  legalEntityId: company,
  ownerModuleId: 'demo.merchandise' as const,
  revision,
  tenantId: context.scope.tenantId,
});

export const executeSymmyDemoCategoriesBatch = Effect.fn('SymmyDemoCatalog.categories')(function* categories(
  context: SymmyDemoCatalogContext,
  request: SymmyDemoCategoriesBatchRequest,
) {
  const company = yield* requireScope(context);
  if (new Set(request.categories.map(({ code }) => code)).size !== request.categories.length) {
    return yield* Effect.fail(symmyInvalidProblem);
  }
  // Parents in this batch must precede their children. Refuse before the first write, never after a partial import.
  const positions = new Map(request.categories.map(({ code }, index) => [code, index]));
  if (
    request.categories.some(({ parentCode }, index) =>
      parentCode === undefined ? false : (positions.get(parentCode) ?? -1) >= index,
    )
  ) {
    return yield* Effect.fail(symmyInvalidProblem);
  }
  const sourceRequestDigest = computeCanonicalValueHash(request);
  let revision = request.expectedRevision;
  const items: Applied[] = [];
  for (const [index, category] of request.categories.entries()) {
    const id = yield* symmyDemoCategoryId(context.scope, category.code);
    const parentId =
      category.parentCode === undefined ? null : yield* symmyDemoCategoryId(context.scope, category.parentCode);
    const payload = yield* decodeCommand(
      {
        _tag: 'CreateCategory',
        id,
        name: category.name,
        parentId,
        ...(category.published === undefined ? {} : { published: category.published }),
        slug: category.slug,
      },
      revision,
      sourceRequestDigest,
    );
    const result = yield* write(context, payload, `category:${index}`);
    if (result.entityIds[0] !== id) {
      return yield* Effect.fail(symmyUnavailableProblem);
    }
    revision = result.revision;
    items.push({ entityId: id, index, outcome: 'APPLIED', revision });
  }
  return response(context, company, items, revision);
});

export const executeSymmyDemoProductsBatch = Effect.fn('SymmyDemoCatalog.products')(function* products(
  context: SymmyDemoCatalogContext,
  request: SymmyDemoProductsBatchRequest,
) {
  const company = yield* requireScope(context);
  const categoryPrefix = yield* symmyDemoCategoryPrefix(context.scope);
  if (request.products.some(({ categoryId }) => categoryId !== undefined && !categoryId.startsWith(categoryPrefix))) {
    return yield* Effect.fail(forbidden);
  }
  const imageHosts = new Set(['www.akros.cz', ...(context.imageHosts ?? [])]);
  if (
    request.products.some(({ images }) =>
      (images ?? []).some((image) => {
        const url = URL.parse(image);
        return (
          url === null ||
          !imageHosts.has(url.hostname) ||
          (url.hostname === 'www.akros.cz' && !url.pathname.startsWith('/data/'))
        );
      }),
    )
  ) {
    return yield* Effect.fail(symmyInvalidProblem);
  }
  const sourceRequestDigest = computeCanonicalValueHash(request);
  let revision = request.expectedRevision;
  const items: Applied[] = [];
  for (const [index, product] of request.products.entries()) {
    const { categoryCode, ...fields } = product;
    const categoryFields =
      categoryCode === undefined ? {} : { categoryId: yield* symmyDemoCategoryId(context.scope, categoryCode) };
    const payload = yield* decodeCommand(
      { ...fields, ...categoryFields, _tag: 'CreateProduct' },
      revision,
      sourceRequestDigest,
    );
    const result = yield* write(context, payload, `product:${index}`);
    const [id] = result.entityIds;
    if (id === undefined || result.entityIds.length !== 1) {
      return yield* Effect.fail(symmyUnavailableProblem);
    }
    revision = result.revision;
    items.push({ entityId: id, index, outcome: 'APPLIED', revision });
  }
  return response(context, company, items, revision);
});

/** CoreMedia verifies content signatures, decoded byte limits, and renditions before it binds the image to the product. */
export const executeSymmyDemoMediaUpload = Effect.fn('SymmyDemoCatalog.media')(function* media(
  context: SymmyDemoCatalogContext,
  request: SymmyDemoMediaUploadRequest,
) {
  const company = yield* requireScope(context);
  const payload = yield* decodeCommand(
    { _tag: 'ChangeProductImages', change: { _tag: 'Upload', image: request.image }, id: request.productId },
    request.expectedRevision,
    computeCanonicalValueHash(request),
  );
  const result = yield* write(context, payload, 'media:0');
  if (
    result.image === undefined ||
    !isMediaImageReference(result.image) ||
    result.entityIds.length !== 1 ||
    result.entityIds[0] !== request.productId
  ) {
    return yield* Effect.fail(symmyUnavailableProblem);
  }
  return response(
    context,
    company,
    [{ entityId: request.productId, image: result.image, index: 0, outcome: 'APPLIED', revision: result.revision }],
    result.revision,
  );
});

export type SymmyDemoCatalogProblem = SymmyIngressProblem | typeof ownerProblemSchema.Type;
