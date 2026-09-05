// expect-count: 3
import { Effect, Layer } from "effect";

interface ContactsGateway {
  readonly list: () => Effect.Effect<string>;
}
interface AuthenticationService {
  readonly verify: () => void;
}

// 1-3: identity-shaped utility wrappers. `readonly T[]` is already unwrapped, and
// `Readonly<…>` is an idiom in this repository (`apps/shell-super-app/src/routes/
// module-entrypoint-loader.ts:20` writes `context: Readonly<TrustedPrincipalContext>`).
export const a = (gateway: Readonly<ContactsGateway>) => gateway;
export const b = (layer: NonNullable<Layer.Layer<AuthenticationService>>) => layer;
export const c = (gateways: ReadonlyArray<ContactsGateway>) => gateways;
