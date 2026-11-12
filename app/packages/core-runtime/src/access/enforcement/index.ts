export type {
  AccessDecisionService,
  GateCarrier,
  GateInput,
  GateMode,
  GateRefusalCode,
  ListGateInput,
  SelectableLegalEntitiesInput,
} from './contract.ts';
export { AccessDecisionGate, GATE_MODES, GATE_REFUSAL_CODES } from './contract.ts';
export type {
  AccessPrincipalKind,
  AccessPrincipalKinds,
  GateActor,
  GateActorResolution,
  PrincipalKindQuery,
} from './actor.ts';
export {
  ACCESS_PRINCIPAL_KINDS,
  AccessPrincipalKindSource,
  AccessPrincipalKindSourceLive,
  WORKLOAD_PRINCIPAL_KINDS,
  isWorkloadPrincipalKind,
  makeDrizzleAccessPrincipalKinds,
  readScopedGatewayPrincipalKind,
  resolveGateActor,
} from './actor.ts';
export type { GateScope } from './capability.ts';
export type { AccessAmount } from '../decision/contract.ts';
export { accessAmountAt, capabilityPolicyOf, gateAmountOf, gateScopeOf } from './capability.ts';
export { seamDenial, seamRefusal, seamUnavailable } from './decisions.ts';
export type { AccessDecisionLogEntry, AccessDecisionLogWriter } from './decision-log.ts';
export type { AccessDecisionLogBatchWriter } from './decision-log-batch.ts';
export {
  AccessDecisionLogBatch,
  AccessDecisionLogBatchLive,
  makeDrizzleAccessDecisionLogBatch,
} from './decision-log-batch.ts';
export {
  AccessDecisionLog,
  AccessDecisionLogLive,
  makeDrizzleAccessDecisionLog,
  shouldRecordDecision,
} from './decision-log.ts';
export type { AccessIntentSource } from '../decision/authority.ts';
export { AccessIntent } from '../decision/authority.ts';
export { AccessIntentLive, decisionAuthorityOf } from './intent-reader.ts';
export { DecisionCheck } from '../decision/engine.ts';
export { DecisionCheckLive } from './enforcement-live.ts';
export type { AccessLegalEntityCandidates } from './legal-entities.ts';
export {
  LegalEntityCandidates,
  LegalEntityCandidatesLive,
  makeDrizzleLegalEntityCandidates,
} from './legal-entities.ts';
export type { AccessDecisionPorts } from './service.ts';
export { AccessDecisionLive, makeAccessDecisionService } from './service.ts';
export type { AccessWorkloadBindings, WorkloadBindingQuery } from './workload-port.ts';
export { AccessWorkloadBindingSource } from './workload-port.ts';
export type { AccessWorkloadBinding, WorkloadBindingStatus } from '../workloads/store.ts';
export {
  AccessWorkloadBindingIdSchema,
  AccessWorkloadBindingStore,
  WORKLOAD_BINDING_STATUSES,
} from '../workloads/store.ts';
export type {
  AccessWorkloadBindingStoreService,
  RegisterWorkloadBindingInput,
  RegisterWorkloadBindingsInput,
  RevokeWorkloadBindingInput,
} from '../workloads/store.ts';
export { AccessWorkloadBindingSourceLive, makeDrizzleAccessWorkloadBindings } from '../workloads/bindings.ts';
export { AccessWorkloadBindingStoreLive, makeAccessWorkloadBindingDrizzleStore } from '../workloads/binding-store.ts';
export type {
  AccessWorkloadCompanyBinding,
  AccessWorkloadCompanyBindingStoreService,
  RegisterWorkloadCompanyBindingInput,
  RegisterWorkloadCompanyBindingsInput,
  RevokeWorkloadCompanyBindingInput,
  WorkloadCompanyBindingStatus,
} from '../workloads/company-store.ts';
export {
  AccessWorkloadCompanyBindingIdSchema,
  AccessWorkloadCompanyBindingStore,
  WORKLOAD_COMPANY_BINDING_STATUSES,
} from '../workloads/company-store.ts';
export {
  AccessWorkloadCompanyBindingStoreLive,
  makeAccessWorkloadCompanyBindingDrizzleStore,
  writeWorkloadCompanyBindings,
} from '../workloads/company-bindings.ts';
export type { TestAccessDecision, TestAccessDecisionSpec, TestGateAnswer } from './testing.ts';
export { makeTestAccessDecision } from './testing.ts';
export type {
  InspectionSubject,
  SubjectAccessInspectionService,
  SubjectActionAnswer,
  SubjectActionInspection,
  SubjectCapabilityAnswer,
  SubjectCapabilityBatchInspection,
  SubjectCapabilityInspection,
  SubjectCapabilityInspectionInput,
  SubjectCapabilityQuestion,
  SubjectInspectionInput,
  SubjectListInspection,
  SubjectScopeInspection,
} from './inspection-contract.ts';
export { SubjectAccessInspection, SubjectInspectionUnavailable } from './inspection-contract.ts';
export { SubjectAccessInspectionLive } from './inspection-live.ts';
export type { SubjectIdentityFacts, SubjectIdentityFactsSource } from './inspection-facts.ts';
export {
  SubjectInspectionIdentitySource,
  SubjectInspectionIdentitySourceLive,
  makeDrizzleSubjectIdentityFacts,
} from './inspection-facts.ts';
export type { SubjectInspectionCatalog, SubjectInspectionPorts } from './inspection.ts';
export { makeSubjectAccessInspection } from './inspection.ts';

export { readScopedSystemWorkloadEnrollment } from '../workloads/system-enrollment.ts';

export { computeActionRequestHash, computeCanonicalValueHash } from '../../actions/repository.ts';
export { readScopedOriginalActionInvocation } from '../workloads/original-action-invocation.ts';
export type { OriginalActionInvocationQuery } from '../workloads/original-action-invocation.ts';

export { readScopedAdmittedWorkload } from './workload-admission.ts';

export {
  openScopedSourceExecutionFence,
  cancelScopedSourceExecutionFence,
} from '../workloads/source-execution-fence.ts';

export { requireScopedSourceExecutionFenceOpen } from '../workloads/source-execution-fence.ts';
export { readScopedSourceExecutionFence } from '../workloads/source-execution-fence.ts';
export type { SourceExecutionFenceFact } from '../workloads/source-execution-fence.ts';
export { readScopedSourceAdmissionEnrollment } from '../workloads/source-admission-enrollment.ts';
export type { SourceAdmissionEnrollmentFact } from '../workloads/source-admission-enrollment.ts';

export { readVerifiedGatewayRecovery } from '../../auth/system-principal-context-provenance.ts';
