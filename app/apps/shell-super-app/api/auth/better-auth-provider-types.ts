import type { EffectDrizzleAuthAdapter } from '@app/better-auth-effect-drizzle/server';
import type { apiKey } from '@better-auth/api-key';
import type { cimd } from '@better-auth/cimd';
import type { mcp } from '@better-auth/mcp';
import type { Auth, BetterAuthOptions } from 'better-auth';
import type { admin } from 'better-auth/plugins/admin';
import type { jwt } from 'better-auth/plugins/jwt';
import type { Effect } from 'effect';

/** The native adapter's public SDK contract exposes no owner executor, schema, or connection. */
export type ShellBetterAuthAdapter = EffectDrizzleAuthAdapter;

/** Public SDK types describe only the session fields and API operations consumed by Shell. */
export interface ShellSessionOptions extends BetterAuthOptions {
  plugins: [
    ReturnType<typeof apiKey>,
    ReturnType<typeof admin>,
    ReturnType<typeof jwt>,
    ReturnType<typeof mcp>,
    ReturnType<typeof cimd>,
  ];
  session: {
    additionalFields: {
      activeContextKind: { defaultValue: 'company'; input: true; required: true; type: 'string' };
      activeLegalEntityId: { input: true; required: false; type: 'string' };
      activeTenantId: { input: true; required: false; type: 'string' };
      impersonationActionId: { input: false; required: false; type: 'string' };
      impersonationOriginalAuthBindingId: { input: false; required: false; type: 'string' };
      impersonationOriginalPrincipalId: { input: false; required: false; type: 'string' };
      impersonationOriginalSessionId: { input: false; required: false; type: 'string' };
      impersonationReason: { input: false; required: false; type: 'string' };
      impersonationTargetPrincipalId: { input: false; required: false; type: 'string' };
    };
  };
}

/** Better Call's final three overloads are headers, status, and body. Shell consumes the headers form. */
type EndpointVariants<Endpoint> = Endpoint extends {
  (context: infer HeaderInput): infer HeaderOutput;
  (context: infer StatusInput): infer StatusOutput;
  (context?: infer BodyInput): infer BodyOutput;
}
  ? {
      body: (context?: BodyInput) => BodyOutput;
      headers: (context: HeaderInput) => HeaderOutput;
      status: (context: StatusInput) => StatusOutput;
    }
  : never;

type HeaderEndpoint<Endpoint> = EndpointVariants<Endpoint>['headers'];

type ShellBetterAuthApi = Auth<ShellSessionOptions>['api'];
export type ShellBetterAuth = Pick<Auth<ShellSessionOptions>, '$context' | 'handler'> & {
  readonly api: Pick<ShellBetterAuthApi, 'getSession' | 'signUpEmail'> & {
    readonly signInEmail: HeaderEndpoint<ShellBetterAuthApi['signInEmail']>;
    readonly signOut: HeaderEndpoint<ShellBetterAuthApi['signOut']>;
    readonly updateSession: HeaderEndpoint<ShellBetterAuthApi['updateSession']>;
  };
};

/** The request-owned native dispatcher keeps SDK operations in the serving fiber and request bindings. */
export type BetterAuthDispatcher = <Value, Failure>(
  operation: (provider: ShellBetterAuth) => Effect.Effect<Value, Failure>,
) => Effect.Effect<Value, Failure>;
