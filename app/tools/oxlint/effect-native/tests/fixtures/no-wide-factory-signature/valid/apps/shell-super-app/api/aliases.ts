import { Effect as Fx, Layer as Lay } from 'effect';

/** Alias-imported Effect: the body is an Effect program, but the input is not an option bag. */
export const makeAuthGateway = (input: AuthGatewayInput) =>
  Fx.gen(function* () {
    const issuer = yield* GatewayIssuer;
    return { input, issuer };
  });

/** Within the limit and no bag-shaped parameter type. */
export const createIssuer = (seed: string, clock: ClockService) => Fx.succeed({ clock, seed });

export const AuthGatewayLive = Lay.effect(
  AuthGateway,
  Fx.gen(function* () {
    return yield* GatewayIssuer;
  }),
);
