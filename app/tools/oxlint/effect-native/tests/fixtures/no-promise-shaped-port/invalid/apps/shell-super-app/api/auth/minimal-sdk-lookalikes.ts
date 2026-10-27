// expect-count: 4
import { betterAuth } from 'better-auth/minimal';
import { betterAuth as unrelatedAuth } from 'better-auth/not-minimal';

// A nearby SDK construction must not exempt an unrelated first-party port.
export const provider = betterAuth({ secret: 'fixture' });
export interface FirstPartyPort {
  readonly load: () => Promise<string>;
}

interface ShadowedProvider {
  readonly api: {
    readonly getSession: () => Promise<string>;
  };
}

// The parameter shadows the real SDK import, so it supplies no foreign-constructor evidence.
export function makeShadowedProvider(betterAuth: (options: object) => ShadowedProvider): ShadowedProvider {
  return betterAuth({});
}

interface UnrecognizedProvider {
  readonly api: {
    readonly getSession: () => Promise<string>;
  };
}

// Recognize only the exact minimal entrypoint, not arbitrary better-auth subpaths.
export const makeUnrecognizedProvider = (): UnrecognizedProvider => unrelatedAuth({});

interface OwnedProvider {
  readonly api: {
    readonly getSession: () => Promise<string>;
  };
}

// Calling a first-party factory beside the native SDK does not make it an SDK mirror.
export const makeOwnedProvider = (factory: () => OwnedProvider): OwnedProvider => factory();
