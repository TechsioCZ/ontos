import type { ActionHandlerContext } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';

import type { CatalogMediaSubjectRef } from '../../shared/actions/catalog-media.ts';
import { CatalogMediaConflict } from './catalog-media-conflict.ts';
import { catalogMediaPersistenceForScope } from '../persistence/catalog-media-persistence.ts';
import type { CatalogMediaOutcome } from '../persistence/catalog-media-persistence.ts';
import { CatalogPersistenceUnavailable } from '../persistence/errors.ts';

export { ProductAuditEvidenceSchema } from '../../shared/domain/product.ts';
export const catalogMediaActionServiceFactory = (...args: Parameters<typeof catalogMediaPersistenceForScope>) =>
  Effect.succeed(catalogMediaPersistenceForScope(...args));
export class CatalogMediaNotFound extends Schema.TaggedError<CatalogMediaNotFound>()('CatalogMediaNotFound', {
  code: Schema.Literal('catalog_media_not_found'),
  reason: Schema.String,
}) {}
export const CatalogMediaActionErrorSchema = Schema.Union([
  CatalogMediaNotFound,
  CatalogMediaConflict,
  CatalogPersistenceUnavailable,
]);

export const checkCatalogMediaScope = (tenantId: string, subjectRef: CatalogMediaSubjectRef, ownerTenantId?: string) =>
  subjectRef.tenantId === tenantId && (ownerTenantId === undefined || ownerTenantId === tenantId)
    ? Effect.void
    : Effect.fail(
        new CatalogMediaNotFound({
          code: 'catalog_media_not_found',
          reason: 'Catalog subject or owner Resource is outside the trusted Tenant',
        }),
      );

export const catalogMediaOutcome = (outcome: CatalogMediaOutcome) =>
  Match.value(outcome).pipe(
    Match.tags({
      assigned: ({ assignmentId, setRevision }) => Effect.succeed({ assignmentId, setRevision }),
      removed: ({ assignmentId, setRevision }) => Effect.succeed({ assignmentId, setRevision }),
      reordered: ({ assignmentId, setRevision }) => Effect.succeed({ assignmentId, setRevision }),
    }),
    Match.tag('not_found', () =>
      Effect.fail(
        new CatalogMediaNotFound({
          code: 'catalog_media_not_found',
          reason: 'Catalog media assignment or subject was not found',
        }),
      ),
    ),
    Match.tag('revision_conflict', ({ actualRevision }) =>
      Effect.fail(
        new CatalogMediaConflict({
          actualRevision,
          code: 'catalog_media_conflict',
          reason: 'Catalog media assignment set changed before this Action committed',
        }),
      ),
    ),
    Match.tag('identity_conflict', () =>
      Effect.fail(
        new CatalogMediaConflict({
          code: 'catalog_media_conflict',
          reason: 'Catalog media assignment cannot be changed from its current state',
        }),
      ),
    ),
    Match.tag('invalid_change', () =>
      Effect.fail(
        new CatalogMediaConflict({
          code: 'catalog_media_conflict',
          reason: 'Catalog media assignment cannot be changed from its current state',
        }),
      ),
    ),
    Match.exhaustive,
  );

type Services = ReturnType<typeof catalogMediaPersistenceForScope>;
export const recordCatalogMediaAccess = Effect.fn('CatalogMediaAction.recordAccess')(
  function* recordCatalogMediaAccessEffect(
    context: ActionHandlerContext<Readonly<Record<string, never>>, Services>,
    subjectRef: CatalogMediaSubjectRef,
  ) {
    yield* context.recordDataAccess({
      accessKind: 'read',
      queryHash: `catalog-media:${subjectRef.resourceType}:${subjectRef.resourceId}`,
      resultCount: 1,
      servingModuleKey: 'commerce.catalog',
      targetModuleKey: 'commerce.catalog',
      targetResourceId: subjectRef.resourceId,
      targetResourceType: subjectRef.resourceType,
    });
  },
);
