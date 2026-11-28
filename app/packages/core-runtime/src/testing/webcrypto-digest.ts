/** A fresh host for a test: no mutation of process-global WebCrypto or other concurrent tests. */
export const webCryptoDigestFixture = (
  digest?: (typeof globalThis.crypto.subtle)['digest'],
): typeof globalThis.crypto =>
  new Proxy(globalThis.crypto, {
    get(_target, key) {
      if (key === 'subtle') {
        return digest === undefined ? undefined : { digest };
      }
      if (key === 'getRandomValues') {
        return _target.getRandomValues.bind(_target);
      }
      return key === 'randomUUID' ? _target.randomUUID.bind(_target) : undefined;
    },
  });
