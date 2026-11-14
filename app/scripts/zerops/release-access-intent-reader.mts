import { Context } from 'effect';

import type { TenantIntentLoader } from '../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';

/** A root-bound runtime reader, separate from the administrative publication database. */
export class ReleaseAccessIntentReader extends Context.Service<
  ReleaseAccessIntentReader,
  (typeof TenantIntentLoader)['Service']
>()('@app/scripts/zerops/ReleaseAccessIntentReader') {}
