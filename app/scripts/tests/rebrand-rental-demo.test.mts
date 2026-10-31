import { demoCompanyTenantId, rentalDemoCompany } from '@app/core-runtime/demo-company-profiles';
import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Match, Redacted } from 'effect';
import { Command } from 'effect/cli';
import { HttpClient, HttpClientError, HttpClientResponse } from 'effect/http';
import type { HttpClientRequest } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { rebrandRentalDemo, rentalDemoRebrandCommand } from '../demo/rebrand-rental-demo.mts';
import { DEFAULT_PASSWORD } from '../ops/stage-demo-verify.mjs';

const origin = 'https://demo.example.test';
const prefix = '/shell-super-app-api/auth';
const signOutPath = `${prefix}/sign-out`;
const writePath = `${prefix}/identity/demo-companies`;
const companyPath = `${prefix}/legal-entities`;
const otherTenant = '70000000-0000-4000-8000-000000000099';
const privateCookie = 'operator-session=private-cookie-never-log';
const sensitive = 'private-password-never-log';
const key = 'source-sha-najempark-v1';
const TENANT_SCOPE = 'tenant-scope';
const options = { apply: true, idempotencyKey: key, password: Redacted.make(sensitive), shellUrl: origin };
const identity = (tenantId = demoCompanyTenantId) => ({
  displayName: 'Demo admin',
  email: 'obchod@demo.ontos',
  principalId: '72000000-0000-4000-8000-000000000020',
  tenantId,
});

interface NativeOptions {
  readonly companyCount?: number;
  readonly companyName?: string;
  readonly failPath?: string;
  readonly loginTenant?: string;
  readonly malformedLogin?: boolean;
  readonly readbackName?: string;
  readonly sessionTenant?: string;
  readonly stallPath?: string;
  readonly started?: Deferred.Deferred<boolean>;
  readonly switchTenant?: string;
  readonly transportFailurePath?: string;
}

const nativeShell = (settings: NativeOptions = {}) => {
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  let reads = 0;
  let writes = 0;
  let selectedTenant = settings.loginTenant ?? demoCompanyTenantId;
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* nativeResponse() {
      requests.push(request);
      expect(url.origin).toBe(origin);
      expect(request.headers.origin).toBe(origin);
      if (url.pathname === `${prefix}/sign-in`) {
        expect(request.headers.cookie).toBeUndefined();
      } else {
        expect(request.headers.cookie).toBe(privateCookie);
      }
      if (url.pathname === writePath) {
        writes += 1;
      }
      if (url.pathname === settings.transportFailurePath) {
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            cause: `${sensitive} ${privateCookie}`,
            request,
          }),
        });
      }
      if (url.pathname === settings.stallPath) {
        if (settings.started !== undefined) {
          yield* Deferred.succeed(settings.started, true);
        }
        return yield* Effect.never;
      }
      let response: Response;
      if (url.pathname === settings.failPath) {
        response = Response.json({ detail: `${sensitive} ${privateCookie}` }, { status: 503 });
      } else if (url.pathname === `${prefix}/sign-in`) {
        response = Response.json(settings.malformedLogin === true ? {} : { identity: identity(selectedTenant) }, {
          headers: { 'set-cookie': `${privateCookie}; Path=/; HttpOnly; Secure` },
        });
      } else if (url.pathname === `${prefix}/session`) {
        response = Response.json({
          availableLegalEntities: [],
          identity: identity(settings.sessionTenant ?? selectedTenant),
          state: 'tenant_authenticated',
        });
      } else if (url.pathname === `${prefix}/tenants`) {
        response = Response.json({ tenants: [{ name: 'Demo', tenantId: demoCompanyTenantId }] });
      } else if (url.pathname === `${prefix}/tenant/switch`) {
        selectedTenant = settings.switchTenant ?? demoCompanyTenantId;
        response = Response.json({ selectedTenantId: selectedTenant });
      } else if (url.pathname === companyPath) {
        reads += 1;
        const legalName =
          reads > 1 ? (settings.readbackName ?? rentalDemoCompany.legalName) : (settings.companyName ?? 'Siampark');
        response = Response.json({
          legalEntities: Array.from({ length: settings.companyCount ?? 1 }, () => ({
            legalEntityId: rentalDemoCompany.legalEntityId,
            legalName,
          })),
          state: 'tenant_authenticated',
          tenantContextAvailable: true,
        });
      } else if (url.pathname === writePath) {
        response = Response.json({ companies: [rentalDemoCompany] });
      } else {
        expect(url.pathname).toBe(signOutPath);
        response = Response.json({ signedOut: true });
      }
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  return { http, requests, writes: () => writes };
};
const bodyOf = (request: HttpClientRequest.HttpClientRequest | undefined) =>
  request === undefined
    ? ''
    : Match.value(request.body).pipe(
        Match.tag('Uint8Array', ({ body }) => new TextDecoder().decode(body)),
        Match.orElse(() => ''),
      );
const pathsOf = (requests: readonly HttpClientRequest.HttpClientRequest[]) =>
  requests.map(({ url }) => new URL(url).pathname);

it.effect('defaults to read-only preflight and closes its private session without a business write', () =>
  Effect.gen(function* preflight() {
    const native = nativeShell();
    const result = yield* rebrandRentalDemo({ shellUrl: origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, native.http),
    );
    expect(result.applied).toBe(false);
    expect(native.writes()).toBe(0);
    expect(pathsOf(native.requests)).toEqual([`${prefix}/sign-in`, `${prefix}/session`, companyPath, signOutPath]);
    expect(bodyOf(native.requests[0])).toBe(
      JSON.stringify({ email: 'obchod@demo.ontos', password: Redacted.value(DEFAULT_PASSWORD) }),
    );
  }),
);

it.effect('applies exactly one native schema-encoded Action with the caller key and verifies readback', () =>
  Effect.gen(function* applyOnce() {
    const native = nativeShell();
    const result = yield* rebrandRentalDemo(options).pipe(Effect.provideService(HttpClient.HttpClient, native.http));
    expect(result).toEqual({ applied: true, ...rentalDemoCompany });
    const write = native.requests.find(({ url }) => new URL(url).pathname === writePath);
    expect(write?.method).toBe('POST');
    expect(write?.headers['idempotency-key']).toBe(key);
    expect(bodyOf(write)).toBe(JSON.stringify({ configuration: 'sales-rental-v1' }));
    expect(native.writes()).toBe(1);
    expect(pathsOf(native.requests).slice(-3)).toEqual([writePath, companyPath, signOutPath]);
  }),
);

for (const example of [
  { name: 'wrong login tenant', settings: { loginTenant: otherTenant }, step: TENANT_SCOPE },
  { name: 'wrong session tenant', settings: { sessionTenant: otherTenant }, step: TENANT_SCOPE },
  { name: 'missing company', settings: { companyCount: 0 }, step: 'rental-company-scope' },
  { name: 'duplicate company', settings: { companyCount: 2 }, step: 'rental-company-scope' },
  { name: 'unrecognized company name', settings: { companyName: 'Unrelated firm' }, step: 'rental-company-name' },
  { name: 'company lookup refused', settings: { failPath: companyPath }, step: 'available-companies' },
]) {
  it.effect(`refuses ${example.name} without a write and still signs out`, () =>
    Effect.gen(function* guardedRefusal() {
      const native = nativeShell(example.settings);
      const failure = yield* rebrandRentalDemo(options).pipe(
        Effect.provideService(HttpClient.HttpClient, native.http),
        Effect.flip,
      );
      expect(failure.step).toBe(example.step);
      expect(native.writes()).toBe(0);
      expect(pathsOf(native.requests).at(-1)).toBe(signOutPath);
    }),
  );
}

it.effect('only an explicit tenant selection may move this private session to the fixed demo tenant', () =>
  Effect.gen(function* selectsExplicitTenant() {
    const native = nativeShell({ loginTenant: otherTenant });
    yield* rebrandRentalDemo({ ...options, selectTenant: true }).pipe(
      Effect.provideService(HttpClient.HttpClient, native.http),
    );
    expect(pathsOf(native.requests).slice(0, 4)).toEqual([
      `${prefix}/sign-in`,
      `${prefix}/tenants`,
      `${prefix}/tenant/switch`,
      `${prefix}/session`,
    ]);
    expect(bodyOf(native.requests[2])).toBe(JSON.stringify({ tenantId: demoCompanyTenantId }));
    expect(native.writes()).toBe(1);
  }),
);

it.effect('rejects a tenant switch that did not select the fixed tenant', () =>
  Effect.gen(function* refusesWrongSwitch() {
    const native = nativeShell({ loginTenant: otherTenant, switchTenant: otherTenant });
    const failure = yield* rebrandRentalDemo({ ...options, selectTenant: true }).pipe(
      Effect.provideService(HttpClient.HttpClient, native.http),
      Effect.flip,
    );
    expect(failure.step).toBe(TENANT_SCOPE);
    expect(native.writes()).toBe(0);
    expect(pathsOf(native.requests).at(-1)).toBe(signOutPath);
  }),
);

for (const settings of [{ failPath: writePath }, { readbackName: 'Siampark' }, { transportFailurePath: writePath }]) {
  it.effect(
    `fails an uncertain/refused write or stale readback without an automatic retry: ${JSON.stringify(settings)}`,
    () =>
      Effect.gen(function* noWriteRetry() {
        const native = nativeShell(settings);
        const failure = yield* rebrandRentalDemo(options).pipe(
          Effect.provideService(HttpClient.HttpClient, native.http),
          Effect.flip,
        );
        expect(native.writes()).toBe(1);
        expect(pathsOf(native.requests).at(-1)).toBe(signOutPath);
        expect(JSON.stringify(failure)).not.toContain(sensitive);
        expect(JSON.stringify(failure)).not.toContain(privateCookie);
      }),
  );
}

it.effect('cleans up the cookie from a login response even when its native response schema is invalid', () =>
  Effect.gen(function* invalidLoginCleanup() {
    const native = nativeShell({ malformedLogin: true });
    const failure = yield* rebrandRentalDemo(options).pipe(
      Effect.provideService(HttpClient.HttpClient, native.http),
      Effect.flip,
    );
    expect(failure.step).toBe('sign-in');
    expect(native.writes()).toBe(0);
    expect(pathsOf(native.requests)).toEqual([`${prefix}/sign-in`, signOutPath]);
  }),
);

it.effect('does not claim success when its own session logout fails', () =>
  Effect.gen(function* refusesUnclosedSession() {
    const native = nativeShell({ failPath: signOutPath });
    const outcome = yield* rebrandRentalDemo(options).pipe(
      Effect.provideService(HttpClient.HttpClient, native.http),
      Effect.exit,
    );
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(native.writes()).toBe(1);
    expect(pathsOf(native.requests).at(-1)).toBe(signOutPath);
    expect(JSON.stringify(outcome)).not.toContain(sensitive);
    expect(JSON.stringify(outcome)).not.toContain(privateCookie);
  }),
);

it.effect('interrupts an in-flight Action and signs out without retrying it', () =>
  Effect.gen(function* cancellationCleanup() {
    const started = yield* Deferred.make<boolean>();
    const native = nativeShell({ stallPath: writePath, started });
    const fiber = yield* rebrandRentalDemo(options).pipe(
      Effect.provideService(HttpClient.HttpClient, native.http),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    expect(native.writes()).toBe(1);
    expect(pathsOf(native.requests).at(-1)).toBe(signOutPath);
  }),
);

it.effect('times out a stalled Action and signs out without exposing its request or retrying', () =>
  Effect.gen(function* timeoutCleanup() {
    const started = yield* Deferred.make<boolean>();
    const native = nativeShell({ stallPath: writePath, started });
    const fiber = yield* rebrandRentalDemo(options).pipe(
      Effect.provideService(HttpClient.HttpClient, native.http),
      Effect.forkChild,
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust('30 seconds');
    const outcome = yield* Fiber.await(fiber);
    expect(Exit.isFailure(outcome)).toBe(true);
    expect(native.writes()).toBe(1);
    expect(pathsOf(native.requests).at(-1)).toBe(signOutPath);
    expect(JSON.stringify(outcome)).not.toContain(privateCookie);
    expect(JSON.stringify(outcome)).not.toContain(sensitive);
  }),
);

for (const shellUrl of [
  'http://remote.example',
  'https://user:secret@example.test',
  'https://demo.example.test/path',
]) {
  it.effect(`rejects an unsafe target before authentication: ${shellUrl}`, () =>
    Effect.gen(function* rejectsOrigin() {
      const native = nativeShell();
      const failure = yield* rebrandRentalDemo({ ...options, shellUrl }).pipe(
        Effect.provideService(HttpClient.HttpClient, native.http),
        Effect.flip,
      );
      expect(failure.step).toBe('target-origin');
      expect(native.requests).toHaveLength(0);
    }),
  );
}

it.effect('requires a stable caller key before authentication for --apply', () =>
  Effect.gen(function* requiresKey() {
    const native = nativeShell();
    const failure = yield* rebrandRentalDemo({ apply: true, shellUrl: origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, native.http),
      Effect.flip,
    );
    expect(failure.step).toBe('apply-requires-idempotency-key');
    expect(native.requests).toHaveLength(0);
  }),
);

for (const apply of [false, true]) {
  it.effect(
    `the actual CLI uses native schema calls and redacted environment credential overrides, apply=${apply}`,
    () =>
      Effect.gen(function* nativeCli() {
        const native = nativeShell();
        yield* Command.runWith(rentalDemoRebrandCommand, { renderErrors: false, version: '1.0.0' })([
          '--shell-url',
          origin,
          ...(apply ? ['--apply', '--idempotency-key', key] : []),
        ]).pipe(
          Effect.provide(NodeServices.layer),
          Effect.provideService(HttpClient.HttpClient, native.http),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                ONTOS_DEMO_REBRAND_EMAIL: 'override@example.test',
                ONTOS_DEMO_REBRAND_PASSWORD: sensitive,
              }),
            ),
          ),
        );
        expect(native.writes()).toBe(apply ? 1 : 0);
        expect(bodyOf(native.requests[0])).toBe(
          JSON.stringify({ email: 'override@example.test', password: sensitive }),
        );
        expect(pathsOf(native.requests).at(-1)).toBe(signOutPath);
      }),
  );
}
