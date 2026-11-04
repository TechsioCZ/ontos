import { Match, Option, Schema } from 'effect';
import type { Feedback } from '../../../../shared/actions/apply-command.ts';
import { ContractSchema, DocumentSchema } from '../../../../shared/apis/records.ts';
import type { RecordsResponse } from '../../../../shared/apis/records.ts';
import type { ContractRef } from '../../../../shared/resources/contract.ts';

export const ResourceIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ResourceId'));
export type ResourceId = Schema.Schema.Type<typeof ResourceIdSchema>;

/** The route may carry exactly one record selector. Two selectors are not a preference order. */
export const AgreementSelectorIssueSchema = Schema.Literals([
  'conflicting_selectors',
  'invalid_contract_id',
  'invalid_document_id',
  'invalid_selector',
]);
export type AgreementSelectorIssue = Schema.Schema.Type<typeof AgreementSelectorIssueSchema>;

export const AgreementSelectorNoneSchema = Schema.TaggedStruct('None', {});
export const AgreementSelectorContractSchema = Schema.TaggedStruct('Contract', { resourceId: ResourceIdSchema });
export const AgreementSelectorDocumentSchema = Schema.TaggedStruct('Document', { documentId: ResourceIdSchema });
export const AgreementSelectorInvalidSchema = Schema.TaggedStruct('Invalid', {
  reason: AgreementSelectorIssueSchema,
});
export const AgreementSelectorSchema = Schema.Union([
  AgreementSelectorNoneSchema,
  AgreementSelectorContractSchema,
  AgreementSelectorDocumentSchema,
  AgreementSelectorInvalidSchema,
]);
export type AgreementSelector = Schema.Schema.Type<typeof AgreementSelectorSchema>;

/** Query fields that make up the selector, whether read from the URL or passed by the Shell. */
export interface AgreementSelectionFields {
  readonly documentId?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly selectorIssue?: AgreementSelectorIssue | undefined;
}

const RawAgreementSearchSchema = Schema.Struct({
  documentId: Schema.optionalKey(ResourceIdSchema),
  resourceId: Schema.optionalKey(ResourceIdSchema),
});
const agreementSearchCodec = Schema.toCodecJson(Schema.fromURLSearchParams(RawAgreementSearchSchema));

/**
 * Reads the owner selector from a raw search string. A malformed or conflicting value is invalid rather than an
 * empty selection: silently dropping it would make a broken deep link look like the record no longer exists.
 */
export const parseAgreementSelector = (search: string): AgreementSelector => {
  const decoded = Option.getOrUndefined(Schema.decodeOption(agreementSearchCodec)(search));
  if (decoded === undefined) {
    return { _tag: 'Invalid', reason: 'invalid_selector' };
  }
  if (decoded.documentId !== undefined && decoded.resourceId !== undefined) {
    return { _tag: 'Invalid', reason: 'conflicting_selectors' };
  }
  if (decoded.documentId !== undefined) {
    return { _tag: 'Document', documentId: decoded.documentId };
  }
  if (decoded.resourceId !== undefined) {
    return { _tag: 'Contract', resourceId: decoded.resourceId };
  }
  return { _tag: 'None' };
};

/** The contract selector alone, for callers that only select contracts. */
export const resourceIdOf = (search: string): string | undefined =>
  Match.value(parseAgreementSelector(search)).pipe(
    Match.tag('Contract', ({ resourceId }) => Option.some(resourceId)),
    Match.orElse(() => Option.none()),
    Option.getOrUndefined,
  );

export const selectorOfFields = ({
  documentId,
  resourceId,
  selectorIssue,
}: AgreementSelectionFields): AgreementSelector => {
  if (selectorIssue !== undefined) {
    return { _tag: 'Invalid', reason: selectorIssue };
  }
  if (documentId !== undefined) {
    return Schema.is(ResourceIdSchema)(documentId)
      ? { _tag: 'Document', documentId }
      : { _tag: 'Invalid', reason: 'invalid_document_id' };
  }
  if (resourceId === undefined) {
    return { _tag: 'None' };
  }
  return Schema.is(ResourceIdSchema)(resourceId)
    ? { _tag: 'Contract', resourceId }
    : { _tag: 'Invalid', reason: 'invalid_contract_id' };
};

export const AgreementDocumentMissingReasonSchema = Schema.Literals([
  'ambiguous',
  'foreign_scope',
  'missing',
  'orphan',
]);
export type AgreementDocumentMissingReason = Schema.Schema.Type<typeof AgreementDocumentMissingReasonSchema>;

export const AgreementDocumentFoundSchema = Schema.TaggedStruct('Found', {
  archived: Schema.Boolean,
  document: DocumentSchema,
  parent: Schema.optionalKey(ContractSchema),
});
export type AgreementDocumentFound = Schema.Schema.Type<typeof AgreementDocumentFoundSchema>;

export const AgreementDocumentNotFoundSchema = Schema.TaggedStruct('NotFound', {
  reason: AgreementDocumentMissingReasonSchema,
});
export type AgreementDocumentNotFound = Schema.Schema.Type<typeof AgreementDocumentNotFoundSchema>;

export const AgreementDocumentSelectionSchema = Schema.Union([
  AgreementDocumentFoundSchema,
  AgreementDocumentNotFoundSchema,
]);
export type AgreementDocumentSelection = Schema.Schema.Type<typeof AgreementDocumentSelectionSchema>;

export interface AgreementDocumentLookup {
  readonly documentId: ResourceId;
  readonly records: Pick<RecordsResponse, 'contracts' | 'documents'>;
  readonly tenantId?: string | undefined;
}

const sameRef = (left: ContractRef, right: ContractRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

/**
 * Resolves a document inside the current authorized records response. A linked document needs its exact current
 * parent in that same response; a deleted, withdrawn, foreign or duplicated parent is never turned into an
 * unlinked document or an arbitrary pick.
 */
export const selectAgreementDocument = ({
  documentId,
  records,
  tenantId,
}: AgreementDocumentLookup): AgreementDocumentSelection => {
  const documents = records.documents.filter((record) => record.documentRef.resourceId === documentId);
  if (documents.length === 0) {
    return { _tag: 'NotFound', reason: 'missing' };
  }
  if (documents.length !== 1) {
    return { _tag: 'NotFound', reason: 'ambiguous' };
  }
  const [document] = documents;
  if (document === undefined) {
    return { _tag: 'NotFound', reason: 'missing' };
  }
  if (tenantId !== undefined && document.documentRef.tenantId !== tenantId) {
    return { _tag: 'NotFound', reason: 'foreign_scope' };
  }
  const { contractRef } = document;
  if (contractRef === null) {
    return {
      _tag: 'Found',
      archived: document.lifecycleState === 'ARCHIVED',
      document,
    };
  }
  if (tenantId !== undefined && contractRef.tenantId !== tenantId) {
    return { _tag: 'NotFound', reason: 'foreign_scope' };
  }
  const parents = records.contracts.filter((contract) => sameRef(contract.contractRef, contractRef));
  if (parents.length === 0) {
    return { _tag: 'NotFound', reason: 'orphan' };
  }
  if (parents.length !== 1) {
    return { _tag: 'NotFound', reason: 'ambiguous' };
  }
  const [parent] = parents;
  if (parent === undefined) {
    return { _tag: 'NotFound', reason: 'missing' };
  }
  if (tenantId !== undefined && parent.contractRef.tenantId !== tenantId) {
    return { _tag: 'NotFound', reason: 'foreign_scope' };
  }
  return {
    _tag: 'Found',
    archived: document.lifecycleState === 'ARCHIVED' || parent.lifecycleState === 'TERMINATED' || parent.isExpired,
    document,
    parent,
  };
};

export const AgreementDocumentForbiddenSchema = Schema.TaggedStruct('Forbidden', {});
export const AgreementDocumentInvalidStateSchema = Schema.TaggedStruct('Invalid', {
  reason: AgreementSelectorIssueSchema,
});
export const AgreementDocumentPendingSchema = Schema.TaggedStruct('Pending', {});
export const AgreementDocumentUnavailableSchema = Schema.TaggedStruct('Unavailable', {});
export const AgreementDocumentStateSchema = Schema.Union([
  AgreementDocumentForbiddenSchema,
  AgreementDocumentInvalidStateSchema,
  AgreementDocumentPendingSchema,
  AgreementDocumentUnavailableSchema,
  AgreementDocumentFoundSchema,
  AgreementDocumentNotFoundSchema,
]);
export type AgreementDocumentState = Schema.Schema.Type<typeof AgreementDocumentStateSchema>;

export interface AgreementDocumentStateInput {
  readonly feedback: Feedback;
  readonly records?: RecordsResponse | undefined;
  readonly selector: AgreementSelector;
  readonly tenantId?: string | undefined;
}

/**
 * Combines the page load state with the owner selection. The page's own read remains the existence proof; the
 * search hit title, router history and any earlier list selection are deliberately not inputs here.
 */
export const agreementDocumentState = ({
  feedback,
  records,
  selector,
  tenantId,
}: AgreementDocumentStateInput): AgreementDocumentState =>
  Match.value(selector).pipe(
    Match.tag('Invalid', ({ reason }): AgreementDocumentState => ({ _tag: 'Invalid', reason })),
    Match.tag('None', (): AgreementDocumentState => ({ _tag: 'NotFound', reason: 'missing' })),
    Match.tag('Contract', (): AgreementDocumentState => ({ _tag: 'NotFound', reason: 'missing' })),
    Match.tag('Document', ({ documentId }): AgreementDocumentState => {
      if (feedback === 'forbidden') {
        return { _tag: 'Forbidden' };
      }
      if (feedback === 'unavailable') {
        return { _tag: 'Unavailable' };
      }
      if (records === undefined || feedback !== 'ready') {
        return { _tag: 'Pending' };
      }
      return selectAgreementDocument({ documentId, records, tenantId });
    }),
    Match.exhaustive,
  );
