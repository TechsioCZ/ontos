import { GatewayNativeEvidence } from './gateway-native-evidence.ts';

import type { TrustedPrincipalContext } from '@app/core-runtime/actions/principal-context';

import type { RegisteredGatewayRouteScope } from '@app/core-runtime/auth/system-principal-context-provenance';
import { Effect } from 'effect';

export const selectOnwardNativeReadReceiver = Effect.fn('GatewayDelegation.selectOnwardNativeReadReceiver')(
  function* select(input: {
    readonly principal: TrustedPrincipalContext;
    readonly routeScope: RegisteredGatewayRouteScope;
    readonly workloadKey: string;
  }) {
    return yield* (yield* GatewayNativeEvidence).selectOnwardNativeReadReceiver(input);
  },
);
