import { Schema } from 'effect';

import { EvidencedTargetResultSchema, OwnerExecutionPhaseSchema } from './privacy-owner/outcome.ts';

const Reference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500), Schema.isTrimmed());
const hasUniqueContent = (results: readonly { readonly contentRef: string }[]): boolean =>
  new Set(results.map(({ contentRef }) => contentRef)).size === results.length;

/**
 * An authorized human's confirmation about the execution of ONE measure Communications took over. It names the measure by its
 * idempotency identity and the exact handoff it was confirmed against (its fingerprint), and it carries only the result the
 * human confirmed per approved target. The human is the authenticated caller: no field of this payload can name a person, a
 * scope or a time.
 */
export const RecordOwnerExecutionEvidencePayloadSchema = Schema.Struct({
  evidenceRef: Reference.pipe(Schema.brand('CommunicationsOwnerEvidenceRef'), Schema.decodeTo(Schema.String)),
  handoffFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  idempotencyKey: Reference.pipe(Schema.brand('CommunicationsMeasureIdempotencyKey'), Schema.decodeTo(Schema.String)),
  phase: OwnerExecutionPhaseSchema,
  results: Schema.Array(
    Schema.Struct({
      contentRef: Reference,
      /** Names the earlier record whose possible-mutation failure of this target this result explicitly reconciles. */
      reconcilesEvidenceRef: Schema.optionalKey(Reference),
      result: EvidencedTargetResultSchema,
    }),
  ).check(
    Schema.isMaxLength(256),
    Schema.makeFilter((results) =>
      hasUniqueContent(results) ? undefined : 'A target may be confirmed once per record',
    ),
    Schema.makeFilter((results) =>
      results.every(
        (entry) => entry.reconcilesEvidenceRef === undefined || entry.result !== 'FAILED_AFTER_POSSIBLE_MUTATION',
      )
        ? undefined
        : 'A reconciliation settles a possible mutation; it cannot itself be another possible mutation',
    ),
  ),
}).check(
  Schema.makeFilter((payload) =>
    payload.phase !== 'RECEIVED' || payload.results.length === 0
      ? undefined
      : { issue: 'A received measure carries no target result', path: ['results'] },
  ),
);
export type RecordOwnerExecutionEvidencePayload = typeof RecordOwnerExecutionEvidencePayloadSchema.Type;

export const RecordOwnerExecutionEvidenceResultSchema = Schema.Struct({
  /** A literal: this Action records evidence and the type cannot say that it performed anything. */
  destructiveActionPerformed: Schema.Literal(false),
  evidenceRef: Schema.String,
  outcome: Schema.Literals(['EXISTS', 'RECORDED']),
});
export type RecordOwnerExecutionEvidenceResult = typeof RecordOwnerExecutionEvidenceResultSchema.Type;
