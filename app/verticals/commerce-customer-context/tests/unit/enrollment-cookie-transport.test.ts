import { getCookies } from 'better-auth/cookies';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { COMMERCE_PORTAL_AUTH_POLICY } from '../../api/portal-auth/provider/config.ts';
import { CommercePortalAuthEnrollmentApi } from '../../shared/portal-auth/enrollment-api.ts';
import { commerceCustomerContextManifest } from '../../vertical.manifest.ts';

const currentEnrollment = CommercePortalAuthEnrollmentApi.groups.portalAuthEnrollment.endpoints;
const transport = commerceCustomerContextManifest.publicSurface.apiCookieTransport ?? [];
const cookiesFor = (method: string, path: string) =>
  transport.flatMap((declaration) =>
    declaration.routes.some((route) => route.method === method && route.path === path) ? declaration.cookieNames : [],
  );
const expectedCookies = [false, true].flatMap((useSecureCookies) => {
  const cookies = getCookies({
    advanced: { cookiePrefix: COMMERCE_PORTAL_AUTH_POLICY.cookie.namePrefix, useSecureCookies },
  });
  return [cookies.sessionToken.name, cookies.dontRememberToken.name];
});

it.effect('declares the provider-issued cookies for the exact email sign-in route', () =>
  Effect.sync(() => {
    expect(cookiesFor('POST', '/api/portal-auth/sign-in/email')).toStrictEqual(expectedCookies);
    expect(cookiesFor('GET', '/api/portal-auth/sign-in/email')).toStrictEqual([]);
    expect(cookiesFor('POST', '/api/portal-auth/sign-in/email/extra')).toStrictEqual([]);
  }),
);

it.effect.each([
  currentEnrollment.readCurrentEnrollment,
  currentEnrollment.resumeCurrentEnrollment,
  currentEnrollment.restartCurrentEnrollment,
])('declares owner session-cookie transport for the current enrollment endpoint $method $path', (endpoint) =>
  Effect.sync(() => {
    expect(expectedCookies).toHaveLength(4);
    expect(cookiesFor(endpoint.method, endpoint.path)).toStrictEqual(expectedCookies);
  }),
);

it.effect.each([
  { method: 'POST', path: '/api/portal-auth/enrollment/current' },
  { method: 'GET', path: '/api/portal-auth/enrollment/current/resume' },
  { method: 'GET', path: '/api/portal-auth/enrollment/current/restart' },
  { method: 'GET', path: '/api/portal-auth/enrollment/current/extra' },
  { method: 'POST', path: '/api/portal-auth/enrollment/start' },
  { method: 'POST', path: '/actions/terminate-portal-enrollment' },
])('keeps cookie transport closed for undeclared methods and routes: $method $path', ({ method, path }) =>
  Effect.sync(() => {
    expect(cookiesFor(method, path)).toStrictEqual([]);
  }),
);
