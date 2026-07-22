import { Schema } from '@modern-js/plugin-bff/effect-client';
import type {
  CoreReference,
  CoreReferenceInsertionResult,
  CoreReferenceOpenResult,
  CoreReferenceResolutionResult,
  DiscoveredCoreReference,
} from '@app/core-runtime/core-reference';

export const coreReferenceSchema: Schema.Schema<CoreReference> = Schema.Struct({
  entityId: Schema.String,
  entityType: Schema.String,
  kind: Schema.Literals(['mention', 'relation']),
  lastResolvedLabel: Schema.String,
  ownerModuleKey: Schema.String,
  targetTenantId: Schema.String,
  token: Schema.String,
});

const discoveredCoreReferenceSchema: Schema.Schema<DiscoveredCoreReference> = Schema.Struct({
  entityId: Schema.String,
  entityType: Schema.String,
  label: Schema.String,
  ownerModuleKey: Schema.String,
  targetTenantId: Schema.String,
  token: Schema.String,
});

const insertionResultSchema: Schema.Schema<CoreReferenceInsertionResult> = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('CoreReferenceInserted'),
    reference: coreReferenceSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal('CoreReferenceRejected'),
    code: Schema.Literals(['ambiguous_reference', 'invalid_source', 'unknown_reference']),
  }),
]);

const resolutionResultSchema: Schema.Schema<CoreReferenceResolutionResult> = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal('CoreReferenceActive'), reference: coreReferenceSchema }),
  Schema.Struct({ _tag: Schema.Literal('CoreReferenceFallback'), reference: coreReferenceSchema }),
]);

const openResultSchema: Schema.Schema<CoreReferenceOpenResult> = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal('CoreReferenceOpened'),
    href: Schema.optional(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.Literal('CoreReferenceOpenDenied') }),
  Schema.Struct({ _tag: Schema.Literal('CoreReferenceOpenUnavailable') }),
]);

export const coreReferenceRequestSchema = Schema.Union([
  Schema.Struct({ operation: Schema.Literal('discover'), query: Schema.String }),
  Schema.Struct({
    kind: Schema.Literals(['mention', 'relation']),
    operation: Schema.Literal('insert'),
    source: Schema.Union([
      Schema.Struct({ type: Schema.Literal('deepLink'), value: Schema.String }),
      Schema.Struct({ type: Schema.Literal('opaqueToken'), value: Schema.String }),
    ]),
  }),
  Schema.Struct({ operation: Schema.Literal('resolve'), reference: coreReferenceSchema }),
  Schema.Struct({ operation: Schema.Literal('open'), reference: coreReferenceSchema }),
]);

export const coreReferenceResponseSchema = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal('discover'),
    references: Schema.Array(discoveredCoreReferenceSchema),
  }),
  Schema.Struct({ operation: Schema.Literal('insert'), result: insertionResultSchema }),
  Schema.Struct({ operation: Schema.Literal('resolve'), result: resolutionResultSchema }),
  Schema.Struct({ operation: Schema.Literal('open'), result: openResultSchema }),
]);

export type CoreReferenceRequest = typeof coreReferenceRequestSchema.Type;
export type CoreReferenceResponse = typeof coreReferenceResponseSchema.Type;
