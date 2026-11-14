import { DateTime, Effect, Schema, SchemaParser, SchemaTransformation } from 'effect';
import { UrlParams } from 'effect/http';
import type { DocumentRecord } from '../../../../../shared/domain/documents.ts';

const DocumentRouteIdSchema = Schema.String.pipe(
  Schema.brand('FacilityDocumentRouteId'),
  Schema.decodeTo(Schema.String),
);
const TaskRouteIdSchema = Schema.String.pipe(
  Schema.brand('FacilityDocumentTaskRouteId'),
  Schema.decodeTo(Schema.String),
);
const SearchFieldsSchema = Schema.Struct({
  doc: Schema.optionalKey(DocumentRouteIdSchema),
  taskId: Schema.optionalKey(TaskRouteIdSchema),
});
type SearchFields = typeof SearchFieldsSchema.Type;
const QueryParamsSchema = Schema.toCodecJson(Schema.URLSearchParams);

/**
 * The Shell exposes this page without installing a page-local TanStack route.
 * Decode its query at the owner boundary with the native query-string codec.
 * Keep URLSearchParams' first-value semantics, including empty and numeric-looking IDs.
 */
export const DocumentsSearchSchema = QueryParamsSchema.pipe(
  Schema.decodeTo(
    SearchFieldsSchema,
    SchemaTransformation.transformEffect({
      decode: (params) => {
        const fields: { -readonly [K in keyof SearchFields]: SearchFields[K] } = {};
        const doc = params.get('doc');
        const taskId = params.get('taskId');
        if (doc !== null) {
          fields.doc = doc;
        }
        if (taskId !== null) {
          fields.taskId = taskId;
        }
        return Effect.succeed(fields);
      },
      encode: (fields) => SchemaParser.decodeEffect(QueryParamsSchema)(UrlParams.toString(fields)),
    }),
  ),
);

export interface DocumentSelection {
  readonly openId: string | undefined;
  readonly searchKey: string;
}

/** Closing a panel sticks until the URL changes; missing or empty `doc` never closes it. */
export const selectionForSearch = (
  current: DocumentSelection | undefined,
  searchKey: string,
  requestedDocument?: string,
): DocumentSelection => {
  if (current?.searchKey === searchKey) {
    return current;
  }
  let openId = current?.openId;
  if (requestedDocument !== undefined && requestedDocument !== '') {
    openId = requestedDocument;
  }
  return { openId, searchKey };
};

const pragueDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' });
export const changedOn = (instant: DateTime.Utc) => pragueDay.format(DateTime.toEpochMillis(instant));

/** Preserve the existing latest-version-or-last-update ordering, including equal-key stability. */
export const documentSortKey = (document: DocumentRecord) => {
  const instant = document.versions.at(-1)?.uploadedAt ?? document.updatedAt;
  return DateTime.toEpochMillis(instant).toString().padStart(16, '0');
};
