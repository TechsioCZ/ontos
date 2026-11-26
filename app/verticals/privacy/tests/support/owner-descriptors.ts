import { extractVerticalRuntimeSafeDescriptors } from '@app/core-runtime';

import { privacyRegistration } from '../../vertical.registration.ts';

/** Public contract data for test compositions, without the private owner registration. */
export const privacyOwnerDescriptors = extractVerticalRuntimeSafeDescriptors(privacyRegistration);
