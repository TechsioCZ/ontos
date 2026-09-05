const kit = { importJWK: (v: string) => v, subtle: { importKey: (v: string) => v } };

export const a = (v: string) => kit.importJWK(v);
export const b = (v: string) => kit.subtle.importKey(v);

export function createSecretKey(seed: string): string {
  return seed;
}

export const c = (seed: string) => createSecretKey(seed);

export const d = (bag: { readonly subtle: { readonly generateKey: () => string } }) => bag.subtle.generateKey();
