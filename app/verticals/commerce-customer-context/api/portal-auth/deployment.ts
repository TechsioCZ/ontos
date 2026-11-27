import { Layer } from 'effect';
import { SecureRandom } from 'effect/crypto';
import { commerceAuthSha256Live } from '../../src/portal-auth/sha256.ts';

/**
 * Platform cryptography for the optional Commerce deployment; the host supplies WebCrypto. This
 * module owns nothing else: the application root
 * (`verticals/commerce-customer-context/api/index.ts`) imports every provider layer from the
 * module that declares it, so no deployment barrel can drift from its owners.
 */
export const commercePortalAuthPlatformCryptoLive = Layer.mergeAll(SecureRandom.layerWebCrypto, commerceAuthSha256Live);
