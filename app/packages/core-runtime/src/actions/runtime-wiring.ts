import { Layer } from 'effect';
import { PrivacyDispatchLivenessSourceLive } from '../access/enforcement/privacy-dispatch-liveness.ts';

import { AccessPrincipalKindSourceLive as principalKindSourceLive } from '../access/enforcement/actor.ts';
import { AccessDecisionLogBatchLive as decisionLogBatchLive } from '../access/enforcement/decision-log-batch.ts';
import { AccessDecisionLogLive as decisionLogLive } from '../access/enforcement/decision-log.ts';
import { DecisionCheckLive as decisionCheckLive } from '../access/enforcement/enforcement-live.ts';
import { AccessIntentLive as intentLive } from '../access/enforcement/intent-reader.ts';
import { LegalEntityCandidatesLive as legalEntityCandidatesLive } from '../access/enforcement/legal-entities.ts';
import { AccessWorkloadBindingSourceLive as workloadBindingSourceLive } from '../access/workloads/bindings.ts';

/**
 * The five ports the enforcement seam reads, ready to hand to `AccessDecisionLive` (CUTOVER-PLAN
 * §3.1 step 8). This is a plain merge, never a `provide`: a library layer stays dependency
 * transparent, so the application root closes the graph (`effect-native/no-layer-provide-in-library`).
 *
 * Every application root (`apps|verticals/<x>/api/index.ts`) composes the seam in two lines, in this
 * order, and reuses the result for the Action runtime, the Read runtime and the scope resolver:
 *
 * ```ts
 * import {
 *   AccessDecisionLive,
 *   AccessEnforcementPortsLive,
 *   TenantIntentLoaderLive,
 * } from '@app/core-runtime/actions/runtime-wiring';
 *
 * const accessEnforcementLive = AccessDecisionLive.pipe(
 *   Layer.provide(AccessEnforcementPortsLive),
 *   Layer.provide(TenantIntentLoaderLive),
 * );
 * ```
 *
 * `AccessIntentLive` reads the intent tables through `TenantIntentLoader`, which is why the outer
 * provide is required; the leaves themselves ask for nothing but `CoreDatabase` and `Crypto`.
 */
export const AccessEnforcementPortsLive = Layer.mergeAll(
  intentLive,
  decisionLogLive,
  // Subject inspection writes every row of one batch in one transaction through the same evidence table.
  decisionLogBatchLive,
  principalKindSourceLive,
  legalEntityCandidatesLive,
  decisionCheckLive,
  workloadBindingSourceLive,
  PrivacyDispatchLivenessSourceLive,
);

export { AccessPrincipalKindSourceLive } from '../access/enforcement/actor.ts';
export { AccessDecisionGate } from '../access/enforcement/contract.ts';
export { AccessDecisionLogBatchLive } from '../access/enforcement/decision-log-batch.ts';
export { AccessDecisionLogLive } from '../access/enforcement/decision-log.ts';
export { DecisionCheckLive } from '../access/enforcement/enforcement-live.ts';
export { AccessIntentLive } from '../access/enforcement/intent-reader.ts';
export { LegalEntityCandidatesLive } from '../access/enforcement/legal-entities.ts';
export { AccessWorkloadBindingSourceLive } from '../access/workloads/bindings.ts';
export { AccessWorkloadBindingStoreLive } from '../access/workloads/binding-store.ts';
export { AccessDecisionLive } from '../access/enforcement/service.ts';
export { TenantIntentLoaderLive } from '../access/intent/tenant-intent-loader.ts';
export { ModuleEntrypointGatewayLive } from '../modules/module-entrypoint-gateway.ts';
export { ModuleStateGateLive } from '../modules/module-state-gate.ts';
export { OperationalScopeResolverLive } from '../operations/context.ts';
export { ActionPermission, ActionPermissionLive, toSpiceDbActionObjectId } from '../permissions/service.ts';
/**
 * The canonical Action-authority seam (CUTOVER-PLAN §4.3): both questions an Action caller asks — may
 * this Action execute, and may it be proposed — are answered by one `AccessDecisionGate.decide` over the
 * Action's own declared carrier. There is no separate `action#execute`/`action#propose` engine; a caller
 * passes the trusted `OperationalScope` it already resolved, never loose ids.
 */
export { ActionAuthority, ActionAuthorityLive } from '../permissions/action-authority.ts';
export type {
  ActionAuthorityQuery,
  ActionAuthorityService,
  ScopedActionAuthority,
} from '../permissions/action-authority.ts';
export { ActionRepositoryLive, computeActionRequestHash } from './repository.ts';
export type { ActionPermissionService } from '../permissions/service.ts';
