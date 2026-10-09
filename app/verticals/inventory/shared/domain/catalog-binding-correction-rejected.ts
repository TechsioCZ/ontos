import { Schema } from 'effect';

export class CatalogBindingCorrectionRejected extends Schema.TaggedError<CatalogBindingCorrectionRejected>()(
  'CatalogBindingCorrectionRejected',
  {
    code: Schema.Literal('catalog_binding_correction_rejected'),
    reason: Schema.Literals([
      'INVALID_CORRECTION_TRANSITION',
      'AFFECTED_ALLOCATION_NOT_FOUND',
      'AFFECTED_ALLOCATION_LINEAGE_MISMATCH',
      'CONFIRMATION_SCOPE_MISMATCH',
      'PROTECTION_SCOPE_MISMATCH',
      'COMMITTED_SCOPE_MISMATCH',
    ]),
  },
) {}
