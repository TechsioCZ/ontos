// A locally bound `crypto` (DI port or local object) is not WebCrypto: the `crypto.subtle`
// chain is matched purely textually, with no scope check on its root identifier.
interface CryptoPort {
  readonly subtle: { readonly importKey: (raw: string) => string; readonly generateKey: () => string };
}

export const viaPort = (crypto: CryptoPort) => crypto.subtle.importKey('raw');

export const viaLocal = (raw: string) => {
  const crypto = { subtle: { importKey: (value: string) => value } };
  return crypto.subtle.importKey(raw);
};
