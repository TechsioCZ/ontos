// @effect-diagnostics nodeBuiltinImport:off -- Inspect source files through the Node filesystem boundary; expires: 2026-12-31.
import { expect, it } from '@app/effect-rstest';
import { readFile } from 'node:fs/promises';

import { Effect, Schema } from 'effect';

import {
  partyRegistryApi,
  partyRegistryApiContract,
  partyRegistryReadinessSchema,
} from '../../shared/api.ts';
import type { OperationContext, partyRegistryOperationContexts } from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const apiNames = [
  'aresLookup',
  'counterpartiesSearch',
  'counterpartyRead',
  'counterpartyRoleHistory',
  'duplicateCandidateDetail',
  'foundation',
  'organizationEngagementMutations',
  'organizationEngagementProfile',
  'partiesSearch',
  'partyCommandRecovery',
  'partyCommands',
  'partyContactPointDetail',
  'partyContactPoints',
  'partyCorrection',
  'partyDetail',
  'partyMatch',
  'partyMatchDecision',
  'partyMergeReadiness',
  'partyOfficialIdentifierDetail',
  'partyOfficialIdentifierHistory',
  'partyRelationshipDetail',
  'personEngagementMutations',
  'personEngagementProfile',
] as const;

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type ReadinessPathRemainsLiteral = Expect<
  Equal<
    typeof partyRegistryApiContract.readinessPath,
    '/party-registry-api/party-registry/readiness'
  >
>;
type ReadinessOperationRouteRemainsLiteral = Expect<
  Equal<
    (typeof partyRegistryOperationContexts)['readiness']['routePath'],
    '/party-registry/readiness'
  >
>;

const operationContextRejectsIdentityMetadata: OperationContext = {
  method: 'GET',
  operationId: 'PartyRegistryApi:/party-registry/readiness',
  routePath: '/party-registry/readiness',
  source: 'generated-client',
  // @ts-expect-error generic operation metadata must not admit trusted identity fields
  tenantId: 'must-not-enter-generic-operation-metadata',
};
void operationContextRejectsIdentityMetadata;
const literalTypeProof: ReadinessPathRemainsLiteral & ReadinessOperationRouteRemainsLiteral = true;
void literalTypeProof;

it('aggregates every governed read and search API beside readiness', () => {
  expect(Object.keys(partyRegistryApi.groups).toSorted()).toEqual(apiNames);
  expect(partyRegistryApiContract).toEqual({
    apiPrefix: '/party-registry-api',
    basePath: '/party-registry-api/party-registry',
    ownerId: 'party-registry',
    readinessPath: '/party-registry-api/party-registry/readiness',
  });

  const endpointPaths = Object.values(partyRegistryApi.groups).flatMap((group) =>
    Object.values(group.endpoints).map(({ path }) => path),
  );
  expect(new Set(Object.keys(partyRegistryApi.groups)).size).toBe(apiNames.length);
  expect(new Set(endpointPaths).size).toBe(endpointPaths.length);
  expect(endpointPaths.includes('/party-registry/readiness')).toBe(true);
  expect(endpointPaths.some((path) => path === '/party-registry')).toBe(false);
  expect(
    endpointPaths.some((path) => path === '/actions' || path === '/party-registry/actions'),
  ).toBe(false);
});

it('keeps readiness tied to the immutable build marker', () => {
  expect(
    Schema.is(partyRegistryReadinessSchema)({
      checks: {
        api: 'ready',
        moduleFederation: 'ready',
        ssr: 'ready',
        translations: 'ready',
      },
      marker: ultramodernApiMarker,
      status: 'ready',
      versionSkew: 'none',
    }),
  ).toBe(true);
});

it.effect('re-exports every governed generated client without exposing private executors', () =>
  Effect.gen(function* testProgram2() {
    const source = yield* Effect.promise(() =>
      readFile(new URL('../../src/api/party-registry-client.ts', import.meta.url), 'utf-8'),
    );

    for (const client of apiNames.filter(
      (name) =>
        name !== 'foundation' &&
        name !== 'organizationEngagementMutations' &&
        name !== 'partyCommands' &&
        name !== 'partyCommandRecovery' &&
        name !== 'personEngagementMutations',
    )) {
      const file = client.replaceAll(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`);
      expect(source).toMatch(new RegExp(`\\./${file}-client\\.ts`, 'u'));
    }
    expect(source).toMatch(/\.\/engagement-profile-client\.ts/u);
    expect(source).toMatch(/getPartyRegistryReadiness/u);
    expect(source).toMatch(/party-command-client/u);
    expect(source).toMatch(/export const partyRegistryClient =/u);
    expect(source).toMatch(/createPartyRegistryHttpClient/u);
    expect(source).not.toMatch(/createPartyRegistryClient/u);
    expect(source).not.toMatch(/makeEffectHttpApiClient\(partyRegistryApi/u);
    expect(source).not.toMatch(
      /export const (?:createPartyRegistry|listPartyRegistry|getPartyRegistry)\s*=/u,
    );
    expect(source).not.toMatch(/action\.ts|runAction|ActionRuntime/u);
  }),
);

it.effect('exposes only the backend Effect API and no placeholder UI module', () =>
  Effect.gen(function* testProgram3() {
    const [frontendFederation, backendFederation, packageSource] = yield* Effect.promise(() =>
      Promise.all([
        readFile(new URL('../../module-federation.config.ts', import.meta.url), 'utf-8'),
        readFile(new URL('../../backend-federation.config.ts', import.meta.url), 'utf-8'),
        readFile(new URL('../../package.json', import.meta.url), 'utf-8'),
      ]),
    );
    const packageJson: { readonly exports: Record<string, string> } =
      yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ exports: Schema.Record(Schema.String, Schema.String) }),
        ),
      )(packageSource);

    expect(frontendFederation).not.toMatch(/['"]\.\/Route['"]|['"]\.\/Widget['"]/u);
    expect(backendFederation).toMatch(/['"]\.\/effect-api['"]/u);
    expect(packageJson.exports['./Route']).toBe(undefined);
    expect(packageJson.exports['./Widget']).toBe(undefined);
    expect(packageJson.exports['./api']).toBe('./shared/api.ts');
    expect(packageJson.exports['./api/client']).toBe('./src/api/party-registry-client.ts');
  }),
);
