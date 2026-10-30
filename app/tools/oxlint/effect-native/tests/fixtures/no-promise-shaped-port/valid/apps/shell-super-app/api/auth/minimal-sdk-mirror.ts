import { betterAuth } from 'better-auth/minimal';
import { admin } from 'better-auth/plugins/admin';

// Better Auth's minimal entrypoint owns these Promise signatures, just like its root entrypoint.
interface SupportAuthProvider {
  readonly api: {
    readonly getSession: (input: { readonly headers: Headers; readonly returnHeaders: true }) => Promise<{
      readonly headers: Headers;
      readonly response: null | {
        readonly session: { readonly id: string };
        readonly user: { readonly id: string };
      };
    }>;
    readonly impersonateUser: (input: {
      readonly body: { readonly userId: string };
      readonly headers: Headers;
      readonly returnHeaders: true;
    }) => Promise<{
      readonly headers: Headers;
      readonly response: { readonly session: { readonly id: string } };
    }>;
    readonly stopImpersonating: (input: { readonly headers: Headers; readonly returnHeaders: true }) => Promise<{
      readonly headers: Headers;
      readonly response: { readonly session: { readonly id: string } };
    }>;
  };
}

export const makeSupportAuthProvider = (secret: string): SupportAuthProvider =>
  betterAuth({ plugins: [admin()], secret }) satisfies SupportAuthProvider;

interface SessionProvider {
  readonly api: {
    readonly getSession: (input: { readonly headers: Headers }) => Promise<null | { readonly user: { readonly id: string } }>;
  };
}

// Immutable aliases retain the SDK constructor's provenance.
const createAuth = betterAuth;
export const makeSessionProvider = (secret: string): SessionProvider => createAuth({ secret });
