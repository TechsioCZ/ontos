import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';

/** Shell receives staff assertions for its own audience; each module owns its receiving trust. */
export const SHELL_STAFF_AUDIENCES: readonly string[] = ['shell-super-app'];

export const StaffAuthenticationNamespaceRegistryLive = staffAuthenticationNamespaceRegistryLayer(SHELL_STAFF_AUDIENCES);
