import type { GatewayActorClaim } from '@app/shared-contracts';
import { Context } from 'effect';
import type { Effect } from 'effect';
import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import type { VerifiedGatewayAssertion, readVerifiedGatewayAssertion } from './gateway-assertion-evidence.ts';
import type { GatewayDelegationError } from './gateway-delegation-errors.ts';
import type { GatewayModuleBinding, GatewayRegisteredWorkloadRule } from './gateway-delegation-policy.ts';
import type { acquireSymmyRouteScopeProof } from './gateway-symmy-route-scope.ts';

export interface NativeReadAdmissionInput {
  readonly actor: GatewayActorClaim;
  readonly audience: string;
  readonly binding: GatewayModuleBinding;
  readonly installed: ShellInstalledCatalog;
  readonly operationRequirementKey: string;
  readonly requestCorrelation: string;
  readonly requestHash: string;
  readonly source: VerifiedGatewayAssertion;
}
export type VerifiedNativeReadSource = NonNullable<ReturnType<typeof readVerifiedGatewayAssertion>>;
export type NativeReadRouteScope = NonNullable<VerifiedNativeReadSource['routeScope']>;
export type NativeReadReceiver = NonNullable<NativeReadRouteScope['nativeReadReceiver']>;
type InstalledContract = ShellInstalledCatalog['contracts'][number];
type RouteRequest = Parameters<typeof acquireSymmyRouteScopeProof>[0]['routeRequest'];
type PolicyDecision<A> = Effect.Effect<A, GatewayDelegationError>;

export interface NativeRoutePolicy {
  readonly admitIntake: (
    input: NativeReadAdmissionInput,
    source: VerifiedNativeReadSource | undefined,
    signedRoute: NativeReadRouteScope | undefined,
  ) => PolicyDecision<{
    readonly destinationModuleId: string;
    readonly entrypointKey: string;
    readonly originalWorkloadKey: string;
    readonly routeRequest: RouteRequest;
    readonly schemaVersion: string;
    readonly signedRoute: NativeReadRouteScope;
    readonly source: VerifiedNativeReadSource;
    readonly sourceModuleId: string;
    readonly workloadKey: string;
  }>;
  readonly admitOnward: (
    input: NativeReadAdmissionInput,
    source: VerifiedNativeReadSource,
    signedRoute: NativeReadRouteScope,
    native: NativeReadReceiver,
  ) => PolicyDecision<{
    readonly consumer: InstalledContract;
    readonly destination: InstalledContract;
    readonly rule: GatewayRegisteredWorkloadRule;
  }>;
  readonly authContextJobKey: string;
}

export class GatewayNativeRoutePolicy extends Context.Service<GatewayNativeRoutePolicy, NativeRoutePolicy>()(
  '@app/shell-super-app/api/auth/gateway-native-route-policy/GatewayNativeRoutePolicy',
) {}
