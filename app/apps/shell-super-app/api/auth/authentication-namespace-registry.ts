import { staffAuthenticationNamespaceRegistryLayer } from '@app/core-runtime/auth/staff-authentication-namespace';
import { Effect, Layer } from 'effect';

import { installedVerticalIds } from '../verticals/installed-verticals.ts';

/** Staff provider trust is owned by this Shell deployment and its installed topology. */
export const StaffAuthenticationNamespaceRegistryLive = Layer.unwrap(
  installedVerticalIds.pipe(
    Effect.map((audiences) => staffAuthenticationNamespaceRegistryLayer(['shell-super-app', ...audiences])),
  ),
);
