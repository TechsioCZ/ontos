import type { AnyActionRegistration } from '../../actions/definition.ts';
// <generated-core-action-catalog-imports>
import { activatePrincipalBindingAction } from './activate-principal-binding.action.ts';
import { bindManagedApiKeyAction } from './bind-managed-api-key.action.ts';
import { bindSelfApiKeyAction } from './bind-self-api-key.action.ts';
import { changePrincipalBindingStatusAction } from './change-principal-binding-status.action.ts';
import { changePrincipalStatusAction } from './change-principal-status.action.ts';
import { changeTenantModuleStateAction } from './change-tenant-module-state.action.ts';
import { configureDemoCompaniesAction } from './configure-demo-companies.action.ts';
import { createNonHumanPrincipalAction } from './create-non-human-principal.action.ts';
import { invitePersonAction } from './invite-person.action.ts';
import { manageDemoAccountAction } from './manage-demo-account.action.ts';
import { recordSupportImpersonationAction } from './record-support-impersonation.action.ts';
import { reservePrincipalBindingAction } from './reserve-principal-binding.action.ts';
import { setCompanyMembershipAction } from './set-company-membership.action.ts';
import { setManagedApiKeyBindingStatusAction } from './set-managed-api-key-binding-status.action.ts';
import { setScopedRoleMembershipAction } from './set-scoped-role-membership.action.ts';
import { setSelfApiKeyBindingStatusAction } from './set-self-api-key-binding-status.action.ts';
// </generated-core-action-catalog-imports>

export type CoreActionDescriptor = AnyActionRegistration['descriptor'];

export const coreActionCatalog: readonly CoreActionDescriptor[] = Object.freeze([
  // <generated-core-action-catalog-values>
  activatePrincipalBindingAction.descriptor,
  bindManagedApiKeyAction.descriptor,
  bindSelfApiKeyAction.descriptor,
  changePrincipalBindingStatusAction.descriptor,
  changePrincipalStatusAction.descriptor,
  changeTenantModuleStateAction.descriptor,
  configureDemoCompaniesAction.descriptor,
  createNonHumanPrincipalAction.descriptor,
  invitePersonAction.descriptor,
  manageDemoAccountAction.descriptor,
  recordSupportImpersonationAction.descriptor,
  reservePrincipalBindingAction.descriptor,
  setCompanyMembershipAction.descriptor,
  setManagedApiKeyBindingStatusAction.descriptor,
  setScopedRoleMembershipAction.descriptor,
  setSelfApiKeyBindingStatusAction.descriptor,
  // </generated-core-action-catalog-values>
]);
