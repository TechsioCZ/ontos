import type { CreatePurposeVersionInput, ProcessingPurpose } from '../../shared/domain/processing-purpose.ts';
import { assessMaterialPrivacyChange } from '../../shared/domain/privacy-material-change.ts';
import type { PrivacyMaterialChangeAssessment } from '../../shared/domain/privacy-material-change.ts';

export const deriveMaterialVersionEvidence = (
  purpose: ProcessingPurpose,
  input: CreatePurposeVersionInput,
  versionId: string,
): PrivacyMaterialChangeAssessment | Readonly<{ conflictReason: string }> => {
  const previous = purpose.versions.at(-1);
  if (previous?.materialScope === undefined || previous.materialScope === null) {
    return {
      conflictReason: 'Purpose Version materiality requires an authoritative persisted previous material scope',
    };
  }
  const evidence = assessMaterialPrivacyChange({
    affectedPrivacySubjectRefs: input.materialChange.affectedPrivacySubjectRefs,
    changedAt: input.materialChange.changedAt,
    changeRef: input.materialChange.changeRef,
    current: {
      ...input.materialScope,
      meaning: input.meaning,
      purposeRef: purpose.purposeRef.resourceId,
      purposeVersionRef: versionId,
    },
    previous: {
      ...previous.materialScope,
      meaning: previous.meaning,
      purposeRef: purpose.purposeRef.resourceId,
      purposeVersionRef: previous.versionId,
    },
  });
  if (evidence.materiality !== 'MATERIAL' || !evidence.applyBlockedUntilCurrentRequirements) {
    return { conflictReason: 'Purpose Version requires an authoritative MATERIAL change assessment' };
  }
  if (input.effectiveFrom < evidence.changedAt) {
    return { conflictReason: 'Purpose Version cannot become effective before its material change evidence' };
  }
  return evidence;
};
