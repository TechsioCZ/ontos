import type { AnyActionRegistration } from '../../actions/definition.ts';
import { configureDemoCompaniesAction } from './configure-demo-companies.action.ts';
import { invitePersonAction } from './invite-person.action.ts';
import { requestPeopleSearchRebuildAction } from './request-people-search-rebuild.action.ts';
// <generated-core-action-catalog-imports>
import { activatePrincipalBindingAction } from './activate-principal-binding.action.ts';
import { attachTenantThemeAction } from './attach-tenant-theme.action.ts';
import { bindManagedApiKeyAction } from './bind-managed-api-key.action.ts';
import { bindSelfApiKeyAction } from './bind-self-api-key.action.ts';
import { changePrincipalBindingStatusAction } from './change-principal-binding-status.action.ts';
import { changePrincipalStatusAction } from './change-principal-status.action.ts';
import { changeSystemWorkloadEnrollmentAction } from './change-system-workload-enrollment.action.ts';
import { changeTenantModuleStateAction } from './change-tenant-module-state.action.ts';
import { configureAgentAction } from './configure-agent.action.ts';
import { confirmAssetAction } from './confirm-asset.action.ts';
import { createNonHumanPrincipalAction } from './create-non-human-principal.action.ts';
import { manageAgentStatusAction } from './manage-agent-status.action.ts';
import { manageDemoAccountAction } from './manage-demo-account.action.ts';
import { mutateAgentProposalsAction } from './mutate-agent-proposals.action.ts';
import { recordAssetIntegrityFailureAction } from './record-asset-integrity-failure.action.ts';
import { recordSupportImpersonationAction } from './record-support-impersonation.action.ts';
import { registerIntegrationWorkloadsAction } from './register-integration-workloads.action.ts';
import { renameDisplayFilenameAction } from './rename-display-filename.action.ts';
import { replaceAgentOperatorsAction } from './replace-agent-operators.action.ts';
import { reservePrincipalBindingAction } from './reserve-principal-binding.action.ts';
import { saveTenantThemeAction } from './save-tenant-theme.action.ts';
import { setCompanyMembershipAction } from './set-company-membership.action.ts';
import { setManagedApiKeyBindingStatusAction } from './set-managed-api-key-binding-status.action.ts';
import { setSelfApiKeyBindingStatusAction } from './set-self-api-key-binding-status.action.ts';
import { uploadAssetAction } from './upload-asset.action.ts';
// </generated-core-action-catalog-imports>

export type CoreActionDescriptor = AnyActionRegistration['descriptor'];

export const coreActionCatalog: readonly CoreActionDescriptor[] = Object.freeze([
  // <generated-core-action-catalog-values>
  activatePrincipalBindingAction.descriptor,
  attachTenantThemeAction.descriptor,
  bindManagedApiKeyAction.descriptor,
  bindSelfApiKeyAction.descriptor,
  changePrincipalBindingStatusAction.descriptor,
  changePrincipalStatusAction.descriptor,
  changeSystemWorkloadEnrollmentAction.descriptor,
  changeTenantModuleStateAction.descriptor,
  configureAgentAction.descriptor,
  confirmAssetAction.descriptor,
  createNonHumanPrincipalAction.descriptor,
  manageAgentStatusAction.descriptor,
  manageDemoAccountAction.descriptor,
  mutateAgentProposalsAction.descriptor,
  recordAssetIntegrityFailureAction.descriptor,
  recordSupportImpersonationAction.descriptor,
  registerIntegrationWorkloadsAction.descriptor,
  renameDisplayFilenameAction.descriptor,
  replaceAgentOperatorsAction.descriptor,
  reservePrincipalBindingAction.descriptor,
  saveTenantThemeAction.descriptor,
  setCompanyMembershipAction.descriptor,
  setManagedApiKeyBindingStatusAction.descriptor,
  setSelfApiKeyBindingStatusAction.descriptor,
  uploadAssetAction.descriptor,
  // </generated-core-action-catalog-values>
  configureDemoCompaniesAction.descriptor,
  invitePersonAction.descriptor,
  requestPeopleSearchRebuildAction.descriptor,
]);

/** Core system Actions have native gateways, never business-module MCP dispatch endpoints. */
export const coreActionMcpCatalog = Object.freeze(
  coreActionCatalog.map(({ actionKey }) =>
    Object.freeze({
      actionKey,
      exposure: 'hidden' as const,
      reason: 'Core system Actions require their dedicated governed gateway and explicit execution authority',
    }),
  ),
);
