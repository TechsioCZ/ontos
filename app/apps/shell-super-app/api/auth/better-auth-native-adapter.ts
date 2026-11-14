import { Context } from 'effect';

import type { ShellBetterAuthAdapter } from './better-auth-provider-types.ts';

/** Request-owned native SDK adapter port; the Auth database owner supplies it without exposing persistence. */
export class BetterAuthNativeAdapter extends Context.Service<
  BetterAuthNativeAdapter,
  { readonly forOptions: ShellBetterAuthAdapter }
>()('@app/shell-super-app/api/auth/better-auth-native-adapter/BetterAuthNativeAdapter') {}
