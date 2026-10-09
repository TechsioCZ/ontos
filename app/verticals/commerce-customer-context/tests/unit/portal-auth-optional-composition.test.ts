import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  CommercePortalAuthConfigError,
  parseOptionalCommercePortalAuthConfig,
} from '../../api/portal-auth/provider/config.ts';

/**
 * The composition root asks this one question to decide whether it installs the provider graph or
 * the fail-closed realm, so the three answers it can give are pinned here: an environment that
 * named nothing opted out, a complete one opted in, and a half-named one is a misconfiguration
 * rather than a silent opt-out.
 */
const COMPLETE_ENVIRONMENT = {
  COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgresql://commerce:secret@localhost/commerce_auth',
  COMMERCE_PORTAL_AUTH_SECRET: 'a'.repeat(32),
  COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test',
} as const;

it.effect('reports no realm for an environment that names no portal value', () =>
  parseOptionalCommercePortalAuthConfig({}).pipe(
    Effect.tap((configuration) =>
      Effect.sync(() => {
        expect(Option.isNone(configuration)).toBe(true);
      }),
    ),
  ),
);

it.effect('reports the parsed realm for a complete environment', () =>
  parseOptionalCommercePortalAuthConfig(COMPLETE_ENVIRONMENT).pipe(
    Effect.tap((configuration) =>
      Effect.sync(() => {
        expect(Option.isSome(configuration)).toBe(true);
        expect(Option.getOrThrow(configuration).baseUrl).toBe('https://portal.example.test');
        expect(Option.getOrThrow(configuration).trustedOrigins).toStrictEqual(['https://portal.example.test']);
      }),
    ),
  ),
);

it.effect('refuses a half-configured realm instead of treating it as an opt-out', () =>
  parseOptionalCommercePortalAuthConfig({ COMMERCE_PORTAL_AUTH_URL: 'https://portal.example.test' }).pipe(
    Effect.flip,
    Effect.tap((failure) =>
      Effect.sync(() => {
        expect(Schema.is(CommercePortalAuthConfigError)(failure)).toBe(true);
      }),
    ),
  ),
);
