import { LegalEntityRefSchema } from '@app/core-runtime/resources/legal-entity';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { Schema } from 'effect';

import { ProductRefSchema } from '../resources/product.ts';
import { VariantRefSchema } from '../resources/variant.ts';
import { ProductEvidenceReferenceSchema, ProductInstantSchema, ProductReasonSchema } from './product.ts';

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const ManufacturerRelationIdSchema = checkedUuid.pipe(
  Schema.brand('CatalogManufacturerRelationId'),
  Schema.decodeTo(checkedUuid),
);
const ManufacturerRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

/** The identity owner is explicit. A name, vendor label, or Selling Legal Entity is never inferred. */
export const ManufacturerTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('PARTY'), partyRef: PartyRefSchema }),
  Schema.Struct({ kind: Schema.Literal('LEGAL_ENTITY'), legalEntityRef: LegalEntityRefSchema }),
]);
export type ManufacturerTarget = typeof ManufacturerTargetSchema.Type;

export const ManufacturerSubjectSchema = Schema.Union([ProductRefSchema, VariantRefSchema]);
export type ManufacturerSubject = typeof ManufacturerSubjectSchema.Type;

/** Effective end is exclusive; a missing bound stays unknown rather than inventing a date. */
export const ManufacturerEffectivePeriodSchema = Schema.Struct({
  effectiveFrom: Schema.optionalKey(ProductInstantSchema),
  effectiveTo: Schema.optionalKey(ProductInstantSchema),
}).check(
  Schema.makeFilter(({ effectiveFrom, effectiveTo }) =>
    effectiveFrom === undefined || effectiveTo === undefined || effectiveFrom < effectiveTo
      ? undefined
      : 'Effective end must follow effective start',
  ),
);

/** Revisions preserve one stable Catalog relation identity and its evidence across corrections. */
export const ManufacturerRelationRevisionSchema = Schema.Struct({
  disposition: Schema.Literals(['CONFIRMED', 'RETRACTED']),
  effectivePeriod: ManufacturerEffectivePeriodSchema,
  evidenceRefs: Schema.NonEmptyArray(ProductEvidenceReferenceSchema),
  reason: ProductReasonSchema,
  recordedAt: ProductInstantSchema,
  relationId: ManufacturerRelationIdSchema,
  revision: ManufacturerRevisionSchema,
  subject: ManufacturerSubjectSchema,
  target: ManufacturerTargetSchema,
}).check(
  Schema.makeFilter(({ subject, target }) => {
    if (target.kind === 'PARTY') {
      return subject.tenantId === target.partyRef.tenantId
        ? undefined
        : 'Manufacturer and Product must share one Tenant';
    }
    return subject.tenantId === target.legalEntityRef.tenantId
      ? undefined
      : 'Manufacturer and Product must share one Tenant';
  }),
);
export type ManufacturerRelationRevision = typeof ManufacturerRelationRevisionSchema.Type;

export const ManufacturerRelationHistorySchema = Schema.NonEmptyArray(ManufacturerRelationRevisionSchema).check(
  Schema.makeFilter((history) => {
    const [first] = history;
    if (first === undefined) {
      return 'Manufacturer relation history cannot be empty';
    }
    return history.every((record, index) => {
      const previous = history[index - 1];
      return (
        record.relationId === first.relationId &&
        record.subject.resourceType === first.subject.resourceType &&
        record.subject.resourceId === first.subject.resourceId &&
        record.subject.tenantId === first.subject.tenantId &&
        record.revision === index + 1 &&
        (previous === undefined || record.recordedAt >= previous.recordedAt)
      );
    })
      ? undefined
      : 'Manufacturer history must preserve relation and subject identity with ordered revisions';
  }),
);
export type ManufacturerRelationHistory = typeof ManufacturerRelationHistorySchema.Type;

/** This is Catalog's effective assertion only; owner status and read permission need separate checks. */
const manufacturerRelationIsCurrent = (record: ManufacturerRelationRevision, at: string): boolean =>
  record.disposition === 'CONFIRMED' &&
  (record.effectivePeriod.effectiveFrom === undefined || record.effectivePeriod.effectiveFrom <= at) &&
  (record.effectivePeriod.effectiveTo === undefined || at < record.effectivePeriod.effectiveTo);

/** A correction supersedes the prior assertion without rewriting it. */
export const currentManufacturerRelation = (
  history: ManufacturerRelationHistory,
  at: string,
): ManufacturerRelationRevision | undefined => {
  const latest = history.at(-1);
  return latest !== undefined && manufacturerRelationIsCurrent(latest, at) ? latest : undefined;
};
