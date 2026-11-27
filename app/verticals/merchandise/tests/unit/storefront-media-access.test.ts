import { ReadHandlerUnavailable, ReadPermissionDenied, TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { TestGateAnswer } from '@app/core-runtime/access/enforcement';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { recordsCarrier } from '../../shared/access-declarations.ts';
import { prepareMediaRead } from '../../src/api/media.read.ts';
import { mediaReadAllowed } from '../../src/services/product-media.ts';

const ownImage = 'media:a973f79c-0f97-476f-a003-f6db822156fb';
const otherImage = 'media:38a013500-0000-4000-8000-000000000001';
const published = { active: true, images: [ownImage], published: true };

/** A Tenant and company created after this release: no identifier of it exists anywhere in the source. */
const freshCompany = {
  legalEntityId: '5b0c51a4-7f0e-4d42-9a43-3f4f4c1d8e61',
  principalId: '9e1d3c4b-2a5f-4b6e-8c7d-0f1e2d3c4b5a',
  tenantId: 'c3a2b1d0-e9f8-4a7b-8c6d-5e4f3a2b1c0d',
};
const decodePrincipal = Schema.decodeSync(TrustedPrincipalContextSchema);
const apiKeyPrincipal = decodePrincipal({
  ...freshCompany,
  authBindingId: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b',
  authContextRef: 'better-auth-api-key:fresh-company-key',
  authMethod: 'api_key',
});
const sessionPrincipal = decodePrincipal({
  ...freshCompany,
  authBindingId: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5c',
  authContextRef: 'better-auth-session:fresh-company-person',
  authMethod: 'session',
});
const mcpPrincipal = decodePrincipal({
  ...freshCompany,
  authBindingId: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5d',
  authContextRef: 'oauth-grant:6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d',
  authMethod: 'oauth_connection',
  connection: {
    clientId: 'fresh-company-mcp',
    clientName: 'MCP client',
    grantId: '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d',
    modules: 'all',
    writePolicy: 'direct',
  },
});
const prepareWith = (principal: typeof apiKeyPrincipal, records: TestGateAnswer) =>
  prepareMediaRead({ ...principal, correlationId: 'fresh-company-media' }).pipe(
    Effect.provideService(
      AccessDecisionGate,
      makeTestAccessDecision({ answers: { [recordsCarrier.accessDeclaration.key]: records } }),
    ),
  );

it.effect('a Storefront key Core admits through its workload reads published images only, in a fresh company', () =>
  Effect.gen(function* registeredStorefront() {
    expect(yield* prepareWith(apiKeyPrincipal, { outcome: 'ALLOWED', reasons: ['allow.workload'] })).toEqual({
      storefront: true,
    });
  }),
);

it.effect('a customer integration key with its own products grant keeps the staff image rule', () =>
  Effect.gen(function* grantedKey() {
    expect(yield* prepareWith(apiKeyPrincipal, { outcome: 'ALLOWED', reasons: ['allow.granted'] })).toEqual({
      storefront: false,
    });
  }),
);

it.effect('a person and their MCP connection read images by their grants, never as the storefront', () =>
  Effect.gen(function* people() {
    for (const principal of [sessionPrincipal, mcpPrincipal]) {
      expect(yield* prepareWith(principal, { outcome: 'ALLOWED' })).toEqual({ storefront: false });
    }
  }),
);

it.effect('a key with neither a bound Storefront workload nor a products grant is refused; an outage is not', () =>
  Effect.gen(function* refusals() {
    const unbound = yield* prepareWith(apiKeyPrincipal, { outcome: 'DENIED', reasons: ['deny.workload_unbound'] }).pipe(
      Effect.flip,
    );
    expect(Schema.is(ReadPermissionDenied)(unbound)).toBe(true);
    const outage = yield* prepareWith(apiKeyPrincipal, { outcome: 'UNAVAILABLE' }).pipe(Effect.flip);
    expect(Schema.is(ReadHandlerUnavailable)(outage)).toBe(true);
  }),
);

it("a storefront read serves a published product's own photo", () => {
  expect(mediaReadAllowed(published, ownImage, true)).toBe(true);
});

it('a storefront read is denied for media the product does not show (unrelated media)', () => {
  expect(mediaReadAllowed(published, otherImage, true)).toBe(false);
});

it("a storefront read serves a variant's own uploaded photo that is not in the gallery", () => {
  expect(mediaReadAllowed({ ...published, images: [], variants: [{ imageSrc: ownImage }] }, ownImage, true)).toBe(true);
});

it('a storefront read is denied for an earlier photo only the library keeps', () => {
  expect(mediaReadAllowed({ ...published, images: [], photoLibrary: [ownImage] }, ownImage, true)).toBe(false);
});

it('a storefront read is denied for an unpublished, inactive or archived product', () => {
  expect(mediaReadAllowed({ ...published, published: false }, ownImage, true)).toBe(false);
  expect(mediaReadAllowed({ ...published, active: false }, ownImage, true)).toBe(false);
  expect(mediaReadAllowed({ ...published, demoArchive: { at: 'x' } }, ownImage, true)).toBe(false);
});

it("staff reads keep their own rule: the product's photos and library decide, visibility does not", () => {
  expect(mediaReadAllowed({ ...published, published: false }, ownImage, false)).toBe(true);
  expect(mediaReadAllowed({ ...published, images: [], photoLibrary: [ownImage] }, ownImage, false)).toBe(true);
  expect(mediaReadAllowed(published, otherImage, false)).toBe(false);
});
