import { Schema } from 'effect';

import type { AnyOutboxWorkerRegistration } from './definition.ts';
import type { OutboxClaim } from './repository.ts';
import type { NativeAdmission } from './worker-runtime-binding.ts';

interface NativeClaimExecution {
  readonly admission: NativeAdmission;
  readonly registration: AnyOutboxWorkerRegistration;
}
interface NativeClaimMint {
  readonly purpose: 'native-outbox-claim';
}
const mint: NativeClaimMint = Object.freeze({ purpose: 'native-outbox-claim' });
/** Immutable claim data plus a private native-admission witness; no caller can mint its token. */
class NativeClaim {
  readonly #execution: NativeClaimExecution | undefined;
  constructor(execution: NativeClaimExecution, token: NativeClaimMint) {
    this.#execution = token === mint ? execution : undefined;
  }
  static evidence(value: NativeClaim): NativeClaimExecution | undefined {
    return #execution in value ? value.#execution : undefined;
  }
}
Object.freeze(NativeClaim.prototype);
Object.freeze(NativeClaim);
const NativeClaimSchema = Schema.instanceOf(NativeClaim);
/** Used only by the existing native repository after its claim fence/claim SQL has succeeded. */
export const attestNativeOutboxClaim = (
  claim: OutboxClaim,
  registration: AnyOutboxWorkerRegistration,
  admission: NativeAdmission,
): OutboxClaim =>
  Object.freeze(Object.assign(new NativeClaim(Object.freeze({ admission, registration }), mint), claim));
export const readNativeOutboxClaim = (claim: OutboxClaim): NativeClaimExecution | undefined =>
  Schema.is(NativeClaimSchema)(claim) ? NativeClaim.evidence(claim) : undefined;
