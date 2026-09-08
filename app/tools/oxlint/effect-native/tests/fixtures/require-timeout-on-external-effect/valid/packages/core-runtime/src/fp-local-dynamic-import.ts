// D-tier server module-loading adapter (source: apps/shell-super-app/api/auth/gateway-issuer.ts:46).
// A bridge containing only a relative static import in a known server path is not a B1 database,
// SpiceDB or remote-provider port. This is a narrow boundary exemption, NOT proof that importing
// any module is pure/deterministic: top-level await and imported code may perform external work.
// Browser-relative chunk imports remain reported (invalid/apps/demo/src/browser-import.ts), as
// does the remote client.load() bridge identified by B1/A9.
import { Effect } from 'effect';

export const loadAudiences = Effect.tryPromise({
  catch: () => new Error('topology unavailable'),
  try: async () => await import('./generated-topology.ts'),
}).pipe(Effect.map((module) => module.installedVerticalIds));
