/* eslint-disable effect-native/no-nullable-schema-field -- Query filters preserve explicit absence on public Privacy wires. expires: 2027-03-31. */
import { Schema } from 'effect';

import { OwnerContributionSchema } from './domain/owner-contribution.ts';
import {
  PrivacyApplicabilityDecisionSchema,
  PrivacyApplicabilityPolicySchema,
} from './domain/privacy-applicability.ts';
import { ConsentDecisionSchema } from './domain/privacy-consent-decision.ts';
import {
  DsrCaseSchema,
  DsrCaseSummarySchema,
  DsrDeadlineSchema,
  DsrOwnerTaskSchema,
  DsrResolverAssignmentSchema,
  DsrResponseSchema,
  DsrSubstantiveDecisionSchema,
  DsrVerificationSchema,
} from './domain/privacy-dsr.ts';
import { PrivacyLegalBasisAssignmentSchema } from './domain/privacy-legal-basis.ts';
import { PrivacyNoticeVersionSchema } from './domain/privacy-notice-version.ts';
import {
  IntendedProcessingScopeSchema,
  PrivacyEligibilityEvidenceSchema,
  PrivacyEligibilityOutcomeSchema,
} from './domain/privacy-processing-eligibility.ts';
import { PrivacyResponsibilityAssignmentSchema } from './domain/privacy-responsibility-assignment.ts';
import { PrivacyRetentionRuleVersionSchema } from './domain/privacy-retention-rule.ts';
import {
  PrivacyIsoTimestampSchema,
  PrivacySubjectRecordSchema,
  RepresentationSchema,
} from './domain/privacy-subject.ts';
import { ProcessingActivitySchema } from './domain/processing-activity.ts';
import { ProcessingActivityRefSchema } from './resources/processing-activity.ts';
import { PrivacySubjectRefSchema } from './resources/privacy-subject.ts';

const Ref = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const Refs = Schema.Array(Ref).check(Schema.isMaxLength(256));
const QueryMetadataSchema = Schema.Struct({ observedAt: PrivacyIsoTimestampSchema });

export const PrivacySubjectsRequestSchema = Schema.Struct({ subjectRefs: Schema.Array(PrivacySubjectRefSchema) });
export const PrivacySubjectsResponseSchema = Schema.Struct({
  items: Schema.Array(PrivacySubjectRecordSchema),
  metadata: QueryMetadataSchema,
  representations: Schema.Array(RepresentationSchema),
});

export const ResponsibilityAssignmentsRequestSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  scopeRefs: Refs,
});
export const ResponsibilityAssignmentsResponseSchema = Schema.Struct({
  items: Schema.Array(PrivacyResponsibilityAssignmentSchema),
  metadata: QueryMetadataSchema,
});

export const ApplicabilityDecisionsRequestSchema = Schema.Struct({
  operation: Schema.NullOr(Ref),
  processingScopeRefs: Refs,
});
export const ApplicabilityDecisionsResponseSchema = Schema.Struct({
  items: Schema.Array(PrivacyApplicabilityDecisionSchema),
  metadata: QueryMetadataSchema,
  policies: Schema.Array(PrivacyApplicabilityPolicySchema),
});

export const ProcessingActivitiesRequestSchema = Schema.Struct({
  activityRefs: Schema.Array(ProcessingActivityRefSchema),
  includeEnded: Schema.Boolean,
});
export const ProcessingActivitiesResponseSchema = Schema.Struct({
  items: Schema.Array(ProcessingActivitySchema),
  metadata: QueryMetadataSchema,
});

export const LegalBasisAssignmentsRequestSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  processingScopeRefs: Refs,
});
export const LegalBasisAssignmentsResponseSchema = Schema.Struct({
  items: Schema.Array(PrivacyLegalBasisAssignmentSchema),
  metadata: QueryMetadataSchema,
});

export const NoticeVersionsRequestSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  languages: Refs,
  noticeRefs: Refs,
});
export const NoticeVersionsResponseSchema = Schema.Struct({
  items: Schema.Array(PrivacyNoticeVersionSchema),
  metadata: QueryMetadataSchema,
});

const ConsentResolutionSchema = Schema.Union([
  Schema.Struct({ decision: ConsentDecisionSchema, outcome: Schema.Literal('CURRENT') }),
  Schema.Struct({ outcome: Schema.Literal('ABSENT') }),
  Schema.Struct({
    decisions: Schema.Array(ConsentDecisionSchema).check(Schema.isMinLength(2)),
    outcome: Schema.Literal('CONFLICT'),
    reason: Schema.Literal('SAME_EFFECTIVE_TIME'),
  }),
]);
export const CurrentConsentRequestSchema = Schema.Struct({ scopeRefs: Refs });
export const CurrentConsentResponseSchema = Schema.Struct({
  items: Schema.Array(Schema.Struct({ resolution: ConsentResolutionSchema, scopeRef: Ref })),
  metadata: QueryMetadataSchema,
});

export const ProcessingEligibilityRequestSchema = Schema.Struct({
  intendedScope: IntendedProcessingScopeSchema,
});
export const ProcessingEligibilityResponseSchema = Schema.Struct({
  evidence: PrivacyEligibilityEvidenceSchema,
  outcome: PrivacyEligibilityOutcomeSchema,
});

export const RetentionRulesRequestSchema = Schema.Struct({
  asOf: PrivacyIsoTimestampSchema,
  contentScopeRefs: Refs,
});
export const RetentionRulesResponseSchema = Schema.Struct({
  items: Schema.Array(PrivacyRetentionRuleVersionSchema),
  metadata: QueryMetadataSchema,
});

export const DsrCasesRequestSchema = Schema.Struct({ caseRefs: Refs });
export const DsrCasesResponseSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      caseRecord: DsrCaseSchema,
      deadlines: Schema.Array(DsrDeadlineSchema),
      decisions: Schema.Array(DsrSubstantiveDecisionSchema),
      ownerContributions: Schema.Array(OwnerContributionSchema),
      resolverAssignments: Schema.Array(DsrResolverAssignmentSchema),
      responses: Schema.Array(DsrResponseSchema),
      summary: DsrCaseSummarySchema,
      tasks: Schema.Array(DsrOwnerTaskSchema),
      verifications: Schema.Array(DsrVerificationSchema),
    }),
  ),
  metadata: QueryMetadataSchema,
});

export const OwnerInventoryRequestSchema = Schema.Struct({ activityRef: ProcessingActivityRefSchema });
export { PrivacyOwnerInventoryResultSchema as OwnerInventoryResponseSchema } from './domain/owner-inventory.ts';
