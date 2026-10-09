import { Effect, Schema } from 'effect';

import type {
  AssortmentSelectionAssessmentV1OperationRequest,
  AssortmentSelectionAssessmentV1ResponseSchema,
  AssortmentSelectionSourceProofV1,
} from '../../shared/apis/assortment-selection-assessment-v1.ts';
import { CatalogSelectionSchema } from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelectionEvidenceServiceResult } from './catalog-selection-evidence-service.ts';
import { sameCatalogSelectionValiditySourceToken } from '../../shared/domain/catalog-selection-validity.ts';

export interface AssortmentSelectionAssessmentV1Source {
  readonly assess: (input: {
    readonly purpose: 'ASSORTMENT';
    readonly selection: AssortmentSelectionSourceProofV1['selection'];
  }) => Effect.Effect<CatalogSelectionEvidenceServiceResult>;
}

type AssortmentSelectionAssessmentV1Response = typeof AssortmentSelectionAssessmentV1ResponseSchema.Type;
const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);
const selectionEvidenceTemporarilyUnavailable = 'Catalog Current selection evidence is temporarily unavailable';

const sourceProofFor = (
  assessment: CatalogSelectionEvidenceServiceResult['evidence'],
): AssortmentSelectionSourceProofV1 | undefined => {
  if (!('status' in assessment) || (assessment.status !== 'VALID' && assessment.status !== 'INVALID')) {
    return undefined;
  }
  return {
    assessedAt: assessment.assessedAt,
    assessmentStatus: assessment.status,
    purpose: 'ASSORTMENT',
    selection: assessment.selection,
    source: 'CATALOG_OWNER_CURRENT_READ',
    sourceToken: assessment.basis,
  };
};

export const assessOrVerifyAssortmentSelectionV1: (
  request: AssortmentSelectionAssessmentV1OperationRequest,
  tenantId: string,
  source: AssortmentSelectionAssessmentV1Source,
) => Effect.Effect<AssortmentSelectionAssessmentV1Response> = Effect.fn('assessOrVerifyAssortmentSelectionV1')(
  function* assessOrVerify(
    request: AssortmentSelectionAssessmentV1OperationRequest,
    tenantId: string,
    source: AssortmentSelectionAssessmentV1Source,
  ) {
    const selection = request.operation === 'ASSESS' ? request.selection : request.sourceProof.selection;
    if (selection.productRef.tenantId !== tenantId || selection.variantRef.tenantId !== tenantId) {
      if (request.operation === 'ASSESS') {
        return {
          assessment: {
            kind: 'UNAVAILABLE',
            reason: 'Catalog selection could not be verified for the trusted Tenant',
          },
          missingRoles: [],
          operation: 'ASSESS',
        } as const;
      }
      return {
        operation: 'VERIFY_CURRENT',
        reason: 'Catalog selection could not be verified for the trusted Tenant',
        status: 'UNAVAILABLE',
      } as const;
    }

    const current = yield* source.assess({ purpose: 'ASSORTMENT', selection });
    const assessment = current.evidence;
    if (request.operation === 'ASSESS') {
      const response = {
        assessment,
        missingRoles: current.missingRoles,
        operation: 'ASSESS' as const,
      };
      const proof = sourceProofFor(assessment);
      return proof === undefined ? response : { ...response, sourceProof: proof };
    }

    if (!('status' in assessment)) {
      return {
        operation: 'VERIFY_CURRENT',
        reason: selectionEvidenceTemporarilyUnavailable,
        status: 'UNAVAILABLE',
      } as const;
    }
    if (
      assessment.purpose !== request.sourceProof.purpose ||
      !sameSelection(assessment.selection, request.sourceProof.selection)
    ) {
      return { assessment, operation: 'VERIFY_CURRENT', status: 'STALE' } as const;
    }
    if (assessment.status === 'INVALID') {
      if (request.sourceProof.assessmentStatus !== 'INVALID') {
        return { assessment, operation: 'VERIFY_CURRENT', status: 'STALE' } as const;
      }
      if (!sameCatalogSelectionValiditySourceToken(request.sourceProof.sourceToken, assessment.basis)) {
        return { assessment, operation: 'VERIFY_CURRENT', status: 'STALE' } as const;
      }
      const verifiedProof = sourceProofFor(assessment);
      return verifiedProof === undefined
        ? {
            operation: 'VERIFY_CURRENT',
            reason: selectionEvidenceTemporarilyUnavailable,
            status: 'UNAVAILABLE',
          }
        : { operation: 'VERIFY_CURRENT', sourceProof: verifiedProof, status: 'CURRENT' };
    }
    if (request.sourceProof.assessmentStatus !== 'VALID') {
      return { assessment, operation: 'VERIFY_CURRENT', status: 'STALE' } as const;
    }
    if (!sameCatalogSelectionValiditySourceToken(request.sourceProof.sourceToken, assessment.basis)) {
      return { assessment, operation: 'VERIFY_CURRENT', status: 'STALE' } as const;
    }
    const verifiedProof = sourceProofFor(assessment);
    if (verifiedProof === undefined) {
      return {
        operation: 'VERIFY_CURRENT',
        reason: selectionEvidenceTemporarilyUnavailable,
        status: 'UNAVAILABLE',
      } as const;
    }
    return { operation: 'VERIFY_CURRENT', sourceProof: verifiedProof, status: 'CURRENT' } as const;
  },
);
