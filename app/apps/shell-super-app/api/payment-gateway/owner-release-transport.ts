import { Effect, Schema } from 'effect';

import { dispatchModuleApiRequest } from '../../src/module-api/transport.ts';

/** The relay reaches the Payment release only through the issuer's URL and these three operations. */
class PaymentOwnerReleaseRefused extends Schema.TaggedError<PaymentOwnerReleaseRefused>()(
  'PaymentOwnerReleaseRefused',
  {},
) {}

const paymentOwner = 'payment';
const relayOrigin = 'https://payment-owner-relay.invalid';
const shellApiMount = '/shell-super-app-api';
const releasePath = /^\/module-api\/payment\/[^/?#\\]+\/payment-api$/u;
const operations: ReadonlySet<string> = new Set([
  'reads/provider-binding-route',
  'payment/actions/capture-provider-notification',
  'payment/actions/request-payment-operation-recovery',
]);

/** Maps the issuer's Payment release URL onto the in-process relay origin; anything else is refused. */
export const resolvePaymentOwnerReleaseBase = Effect.fn('PaymentOwnerRelay.resolve')(function* resolve(path: string) {
  const relative = path.slice(shellApiMount.length);
  if (!path.startsWith(shellApiMount) || !releasePath.test(relative)) {
    return yield* new PaymentOwnerReleaseRefused();
  }
  const url = new URL(relative, relayOrigin);
  return url.pathname === relative ? url : yield* new PaymentOwnerReleaseRefused();
});

/** Fetch edge of the generated Payment clients: one exact POST operation of the approved Payment release. */
export const forwardPaymentOwnerRelease = Effect.fn('PaymentOwnerRelay.forward')(function* forward(
  input: RequestInfo | URL,
  init?: RequestInit,
) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const segments = url.pathname.split('/');
  if (
    url.origin !== relayOrigin ||
    !releasePath.test(segments.slice(0, 5).join('/')) ||
    segments[2] !== paymentOwner ||
    !operations.has(segments.slice(5).join('/')) ||
    url.search !== '' ||
    request.method !== 'POST'
  ) {
    return yield* new PaymentOwnerReleaseRefused();
  }
  return yield* dispatchModuleApiRequest(request);
});
