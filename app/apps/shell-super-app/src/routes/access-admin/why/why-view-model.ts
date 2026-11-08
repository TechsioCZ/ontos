import { Schema } from 'effect';

// Form text is not a validated capability/company/record identity. These input brands keep
// parsed form fields distinct; the route validates them with P1's domain schemas before I/O.
const WhyCapabilityInputSchema = Schema.Trim.pipe(Schema.brand('WhyCapabilityInput'));
const WhyCompanyInputSchema = Schema.Trim.pipe(Schema.brand('WhyCompanyInput'));
const WhyRecordInputSchema = Schema.Trim.pipe(Schema.brand('WhyRecordInput'));
export const WhySearchDraftSchema = Schema.Struct({
  capabilityKey: WhyCapabilityInputSchema,
  companyId: WhyCompanyInputSchema,
  currency: Schema.Trim,
  minor: Schema.Trim,
  mode: Schema.Trim,
  recordKey: WhyRecordInputSchema,
  subject: Schema.Trim,
  targetModule: Schema.Trim,
});
export type WhySearchDraft = typeof WhySearchDraftSchema.Encoded;

export const emptyWhySearch: WhySearchDraft = {
  capabilityKey: '',
  companyId: '',
  currency: '',
  minor: '',
  mode: 'run',
  recordKey: '',
  subject: '',
  targetModule: '',
};

export type WhySubjectOptions =
  | { readonly state: 'hidden' }
  | { readonly state: 'unavailable' }
  | {
      readonly nextCursor: string | null;
      readonly people: readonly { readonly label: string; readonly value: string }[];
      readonly revision: string;
      readonly state: 'ready';
    };

export const hiddenWhySubjects: WhySubjectOptions = { state: 'hidden' };

export interface WhyDecisionView {
  readonly authority: readonly {
    readonly deadline: string | null;
    readonly id: string;
    readonly name: string;
  }[];
  readonly authorityMetadata: 'included' | 'withheld' | 'unavailable';
  readonly deadline: string | null;
  readonly fieldClass: string | null;
  readonly grantableBy: readonly { readonly id: string; readonly name: string }[];
  readonly outcome: 'allowed' | 'denied' | 'needsApproval';
  readonly reasonKeys: readonly string[];
  readonly subjectName: string | null;
}

export type WhyResultView =
  | { readonly state: 'idle' | 'invalid' | 'forbidden' | 'unauthenticated' | 'unavailable' | 'conflict' }
  | { readonly decision: WhyDecisionView; readonly query: WhySearchDraft; readonly state: 'decision' };

export interface WhyCheckState {
  readonly draft: WhySearchDraft;
  readonly result: WhyResultView;
  readonly subjectsDenied: boolean;
}

export const completeWhyCheck = (
  previous: WhyCheckState,
  draft: WhySearchDraft,
  result: WhyResultView,
): WhyCheckState => {
  const subjectRefused = result.state === 'forbidden' && draft.subject.length > 0;
  return {
    draft: subjectRefused ? { ...draft, subject: '' } : draft,
    result,
    subjectsDenied: previous.subjectsDenied || subjectRefused,
  };
};

// Only stable, reviewed codes become translation keys. Never render server diagnostics or
// unknown codes as text, or allow them to select arbitrary translation namespaces.
const reasonCodes = new Set([
  'allow.granted',
  'approval.required',
  'deny.agent_forbidden',
  'deny.agent_sensitive_read',
  'deny.amount_exceeds_ceiling',
  'deny.amount_required',
  'deny.caveat_indeterminate',
  'deny.connection_ceiling',
  'deny.connection_inactive',
  'deny.consent_stale',
  'deny.deadline_passed',
  'deny.declaration_missing',
  'deny.insufficient_grant',
  'deny.mode_unsupported',
  'deny.parent_read_required',
  'deny.principal_kind_forbidden',
  'deny.scope_mismatch',
  'deny.target_required',
  'deny.workload_forbidden',
  'deny.workload_only',
  'structural.owner',
  'structural.access_admin',
  'structural.access_admin_any',
  'structural.delegation',
]);

export const whyReasonKey = (code: string): string =>
  reasonCodes.has(code) ? `shell.accessAdmin.reason.${code}` : 'shell.accessAdmin.why.unknownReason';
