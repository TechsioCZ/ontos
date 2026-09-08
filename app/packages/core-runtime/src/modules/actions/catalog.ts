import type { AnyActionRegistration } from '../../actions/definition.ts';
// <generated-core-action-catalog-imports>
import { bindManagedApiKeyAction } from './bind-managed-api-key.action.ts';
import { bindSelfApiKeyAction } from './bind-self-api-key.action.ts';
import { changePrincipalStatusAction } from './change-principal-status.action.ts';
import { changeTenantModuleStateAction } from './change-tenant-module-state.action.ts';
import { createNonHumanPrincipalAction } from './create-non-human-principal.action.ts';
import { recordSupportImpersonationAction } from './record-support-impersonation.action.ts';
import { setManagedApiKeyBindingStatusAction } from './set-managed-api-key-binding-status.action.ts';
import { setSelfApiKeyBindingStatusAction } from './set-self-api-key-binding-status.action.ts';
// </generated-core-action-catalog-imports>

export type CoreActionDescriptor = AnyActionRegistration['descriptor'];

export const coreActionCatalog: readonly CoreActionDescriptor[] = Object.freeze([
  // <generated-core-action-catalog-values>
  bindManagedApiKeyAction.descriptor,
  bindSelfApiKeyAction.descriptor,
  changePrincipalStatusAction.descriptor,
  changeTenantModuleStateAction.descriptor,
  createNonHumanPrincipalAction.descriptor,
  recordSupportImpersonationAction.descriptor,
  setManagedApiKeyBindingStatusAction.descriptor,
  setSelfApiKeyBindingStatusAction.descriptor,
  // </generated-core-action-catalog-values>
]);
