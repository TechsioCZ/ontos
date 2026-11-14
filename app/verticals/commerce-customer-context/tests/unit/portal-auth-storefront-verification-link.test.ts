import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { EmailDeliveryService } from '@app/email-delivery/server';
import { Effect, Redacted } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { makeCommercePortalAuthOptions } from '../../api/portal-auth/provider/auth.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { makeCommercePortalAuthTransactionalEmail } from '../../api/portal-auth/provider/transactional-email.ts';
import {
  storefrontVerificationCallback,
  storefrontVerificationLink,
} from '../../api/portal-auth/provider/storefront-verification-link.ts';
import { COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH } from '../../shared/deployment-paths.ts';

// The realm is configured on one storefront; a second storefront proxies the same realm under its own origin.
const REALM_STOREFRONT = 'https://akros.storefront.example.test';
const SECOND_STOREFRONT = 'https://shop.storefront.example.test';
const EMAIL = 'storefront-link@example.test';
const PASSWORD = 'P'.repeat(24);
const TRUSTED = [REALM_STOREFRONT, SECOND_STOREFRONT];
const realmLink = (storefront: string) =>
  `${REALM_STOREFRONT}${COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH}/verify-email?token=t0k&callbackURL=${encodeURIComponent(storefront)}`;

describe('storefront verification link', () => {
  it('returns the link to the trusted storefront the customer registered on', () => {
    const link = new URL(storefrontVerificationLink(realmLink(`${SECOND_STOREFRONT}/`), TRUSTED));
    expect(link.origin).toBe(SECOND_STOREFRONT);
    expect(link.pathname).toBe(`${COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH}/verify-email`);
    expect(link.searchParams.get('token')).toBe('t0k');
    expect(link.searchParams.has('callbackURL')).toBe(false);
  });

  it('never rebases onto an untrusted or missing storefront', () => {
    const foreign = realmLink('https://attacker.example.test/');
    expect(storefrontVerificationLink(foreign, TRUSTED)).toBe(foreign);
    const bare = `${REALM_STOREFRONT}${COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH}/verify-email?token=t0k`;
    expect(storefrontVerificationLink(bare, TRUSTED)).toBe(bare);
  });

  it.effect('mails the registering storefront from a real Better Auth realm configured on another one', () =>
    Effect.gen(function* realmSend() {
      const configuration = yield* parseCommercePortalAuthConfig({
        COMMERCE_PORTAL_AUTH_DATABASE_URL: 'postgresql://commerce:secret@example.test/commerce_auth',
        COMMERCE_PORTAL_AUTH_SECRET: 's'.repeat(64),
        COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: SECOND_STOREFRONT,
        COMMERCE_PORTAL_AUTH_URL: REALM_STOREFRONT,
      });
      const mailed: string[] = [];
      const emailDelivery = yield* makeCommercePortalAuthTransactionalEmail().pipe(
        Effect.provideService(EmailDeliveryService, {
          send: (message) =>
            Effect.sync(() => {
              mailed.push(Redacted.value(message.text));
              return { accepted: true, id: `fixture-email-${mailed.length}` };
            }),
        }),
        Effect.provideService(CommercePortalAuthConfig, configuration),
      );
      const options = yield* makeCommercePortalAuthOptions({
        configuration,
        databaseAdapter: memoryAdapter({}),
        emailDelivery,
      });
      const auth = betterAuth({
        ...options,
        database: memoryAdapter({ account: [], rateLimit: [], session: [], user: [], verification: [] }),
      });
      yield* Effect.promise(() =>
        auth.api.signUpEmail({
          body: { email: EMAIL, name: 'Storefront Link', password: PASSWORD },
          headers: { origin: SECOND_STOREFRONT },
        }),
      );
      yield* Effect.promise(() =>
        auth.api.sendVerificationEmail({
          body: { callbackURL: storefrontVerificationCallback(new URL(SECOND_STOREFRONT)), email: EMAIL },
        }),
      );
      const link = mailed.at(0)?.match(/https:\/\/\S+/u)?.[0];
      expect(link === undefined ? undefined : new URL(link).origin).toBe(SECOND_STOREFRONT);
      expect(link === undefined ? undefined : new URL(link).pathname).toBe(
        `${COMMERCE_PORTAL_AUTH_PUBLIC_BASE_PATH}/verify-email`,
      );
    }),
  );
});
