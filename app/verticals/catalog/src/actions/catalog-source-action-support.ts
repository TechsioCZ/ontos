import type { ActionHandlerContext, OutboxMessage } from '@app/core-runtime';
import { Effect, Schema } from 'effect';

import { OutboxPayloadSchema } from '../../shared/outbox/commerce-catalog-selection-source-changed-v1.ts';
import { CatalogSourceResolutionUnavailable } from '../persistence/catalog-source-resolution-ports.ts';
import type {
  CatalogResolvedCurrentEventPorts,
  CatalogResolvedCurrentSourceRevision,
} from '../persistence/catalog-source-resolution-ports.ts';

export class CatalogSourceRequestInvalid extends Schema.TaggedError<CatalogSourceRequestInvalid>()(
  'CatalogSourceRequestInvalid',
  { code: Schema.Literal('catalog_source_request_invalid'), reason: Schema.String },
) {}

export const CatalogSourceActionErrorSchema = Schema.Union([
  CatalogSourceRequestInvalid,
  CatalogSourceResolutionUnavailable,
]);
const isCatalogSourceResolutionUnavailable = Schema.is(CatalogSourceResolutionUnavailable);

export const CatalogSourceAuditEvidenceSchema = Schema.Struct({
  evidenceRefs: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed())),
  reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed()),
});

const changeKind = {
  IMPORT_ACCEPTED: 'BASE_ACCEPTED',
  OVERRIDE_ACTIVATED: 'LOCAL_OVERRIDE_ACTIVATED',
  OVERRIDE_CHANGED: 'LOCAL_OVERRIDE_CHANGED',
  OVERRIDE_RELEASED: 'LOCAL_OVERRIDE_RELEASED',
} as const;

const subjectResourceType = {
  PACKAGE_DEFINITION: 'commerce.catalog.package-definition',
  PRODUCT: 'commerce.catalog.product',
  VARIANT: 'commerce.catalog.variant',
} as const;

const encodeSourceRevision = (source: CatalogResolvedCurrentSourceRevision) =>
  source.kind === 'ACCEPTED_BASE'
    ? { ...source, sourceRevision: source.sourceRevision.toString() }
    : { ...source, revision: source.revision.toString() };

export const catalogResolvedCurrentEventPorts = <Services>(
  context: ActionHandlerContext<
    { readonly 'commerce.catalog.selection-source-changed.v1': typeof OutboxPayloadSchema },
    Services
  >,
  createMessage: (payload: typeof OutboxPayloadSchema.Type) => OutboxMessage,
): CatalogResolvedCurrentEventPorts<Schema.Json> => ({
  emitResolvedCurrentChanged: ({ cause: sourceChangeCause, ...input }) =>
    Schema.decodeEffect(OutboxPayloadSchema)({
      changeId: context.actionInvocationId,
      changeKind: changeKind[sourceChangeCause],
      factKey: input.scope.factKey,
      source: encodeSourceRevision(input.sourceRevision),
      sourceKind: 'CATALOG_FACT',
      targetId: input.scope.targetId,
      targetKind: input.scope.targetKind,
      tenantId: input.scope.tenantId,
    }).pipe(
      Effect.mapError((cause) => {
        const error = new CatalogSourceResolutionUnavailable({
          code: 'catalog_source_resolution_unavailable',
          reason: 'Catalog could not encode exact source revision change evidence',
        });
        Object.defineProperty(error, 'cause', { configurable: true, value: cause });
        return error;
      }),
      Effect.flatMap((payload) =>
        context
          .addDomainEvent({
            eventType: 'commerce.catalog.selection-source-changed.v1',
            payloadJson: payload,
            producerModuleKey: 'commerce.catalog',
            subjectModuleKey: 'commerce.catalog',
            subjectResourceId: input.scope.targetId,
            subjectResourceType: subjectResourceType[input.scope.targetKind],
          })
          .pipe(Effect.flatMap((event) => context.addOutboxMessage(event, createMessage(payload)))),
      ),
      Effect.mapError((cause) => {
        if (isCatalogSourceResolutionUnavailable(cause)) {
          return cause;
        }
        const error = new CatalogSourceResolutionUnavailable({
          code: 'catalog_source_resolution_unavailable',
          reason: 'Catalog could not record source revision change evidence',
        });
        Object.defineProperty(error, 'cause', { configurable: true, value: cause });
        return error;
      }),
    ),
});
