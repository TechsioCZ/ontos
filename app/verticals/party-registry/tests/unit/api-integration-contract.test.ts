// @effect-diagnostics asyncFunction:off nodeBuiltinImport:off
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { Schema } from 'effect';

import {
  partyRegistryApi,
  partyRegistryApiContract,
  partyRegistryReadinessSchema,
} from '../../shared/api.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';

const apiNames = [
  'aresLookup',
  'counterpartiesSearch',
  'counterpartyRead',
  'counterpartyRoleHistory',
  'duplicateCandidateDetail',
  'foundation',
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
] as const;

const serverFiles = [
  'ares-lookup-read-server',
  'counterparties-search-server',
  'counterparty-read-read-server',
  'counterparty-role-history-read-server',
  'duplicate-candidate-detail-read-server',
  'parties-search-server',
  'party-contact-point-detail-read-server',
  'party-contact-points-read-server',
  'party-correction-read-server',
  'party-detail-read-server',
  'party-match-decision-read-server',
  'party-match-read-server',
  'party-merge-readiness-read-server',
  'party-official-identifier-detail-read-server',
  'party-official-identifier-history-read-server',
  'party-relationship-detail-read-server',
] as const;

test('aggregates every governed read and search API beside readiness', () => {
  assert.deepEqual(Object.keys(partyRegistryApi.groups).toSorted(), apiNames);
  assert.deepEqual(partyRegistryApiContract, {
    apiPrefix: '/party-registry-api',
    basePath: '/party-registry-api/party-registry',
    ownerId: 'party-registry',
    readinessPath: '/party-registry-api/party-registry/readiness',
  });

  const endpointPaths = Object.values(partyRegistryApi.groups).flatMap((group) =>
    Object.values(group.endpoints).map(({ path }) => path),
  );
  assert.equal(new Set(Object.keys(partyRegistryApi.groups)).size, apiNames.length);
  assert.equal(new Set(endpointPaths).size, endpointPaths.length);
  assert.equal(endpointPaths.includes('/party-registry/readiness'), true);
  assert.equal(
    endpointPaths.some((path) => path === '/party-registry'),
    false,
  );
  assert.equal(
    endpointPaths.some((path) => path === '/actions' || path === '/party-registry/actions'),
    false,
  );
});

test('keeps readiness tied to the immutable build marker', () => {
  assert.equal(
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
    true,
  );
});

test('composes generated governed servers through the Core read runtime', async () => {
  const source = await readFile(new URL('../../api/index.ts', import.meta.url), 'utf-8');

  for (const serverFile of serverFiles) {
    assert.match(source, new RegExp(serverFile.replaceAll('-', '[-]'), 'u'));
  }
  assert.match(source, /makeReadRuntimeLive\(ContextAccessLive\)/u);
  assert.match(source, /Layer\.provide\(CorePersistenceLive\)/u);
  assert.doesNotMatch(source, /partyRegistryItems|Wire a real|generated-party-registry/u);
  assert.doesNotMatch(source, /\.handle\(['"]create['"]/u);
  assert.match(source, /ActionRuntimeLive/u);
  assert.match(source, /partyRegistryCommandsLive/u);
});

test('re-exports every governed generated client without exposing private executors', async () => {
  const source = await readFile(
    new URL('../../src/api/party-registry-client.ts', import.meta.url),
    'utf-8',
  );

  for (const client of apiNames.filter(
    (name) => name !== 'foundation' && name !== 'partyCommands' && name !== 'partyCommandRecovery',
  )) {
    const file = client.replaceAll(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`);
    assert.match(source, new RegExp(`\\./${file}-client\\.ts`, 'u'));
  }
  assert.match(source, /getPartyRegistryReadiness/u);
  assert.match(source, /party-command-client/u);
  assert.match(source, /export const partyRegistryClient =/u);
  assert.match(source, /makeEffectHttpApiClient\(partyRegistryFoundationApi/u);
  assert.doesNotMatch(source, /createPartyRegistryClient/u);
  assert.doesNotMatch(source, /makeEffectHttpApiClient\(partyRegistryApi/u);
  assert.doesNotMatch(
    source,
    /export const (?:createPartyRegistry|listPartyRegistry|getPartyRegistry)\s*=/u,
  );
  assert.doesNotMatch(source, /action\.ts|runAction|ActionRuntime/u);
});

test('exposes only the backend Effect API and no placeholder UI module', async () => {
  const [frontendFederation, backendFederation, packageSource] = await Promise.all([
    readFile(new URL('../../module-federation.config.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../backend-federation.config.ts', import.meta.url), 'utf-8'),
    readFile(new URL('../../package.json', import.meta.url), 'utf-8'),
  ]);
  const packageJson: { readonly exports: Record<string, string> } = JSON.parse(packageSource);

  assert.doesNotMatch(frontendFederation, /['"]\.\/Route['"]|['"]\.\/Widget['"]/u);
  assert.match(backendFederation, /['"]\.\/effect-api['"]/u);
  assert.equal(packageJson.exports['./Route'], undefined);
  assert.equal(packageJson.exports['./Widget'], undefined);
  assert.equal(packageJson.exports['./api'], './shared/api.ts');
  assert.equal(packageJson.exports['./api/client'], './src/api/party-registry-client.ts');
});
