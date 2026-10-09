import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';

/** Shell receives staff assertions for its own audience; each module owns its receiving trust. */
export const StaffAuthenticationNamespaceRegistryLive = staffAuthenticationNamespaceRegistryLayer(['shell-super-app']);
