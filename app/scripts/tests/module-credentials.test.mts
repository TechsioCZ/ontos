import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { DateTime, Effect, Exit, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { HostedModuleCredentialsSchema } from '../../packages/core-runtime/src/auth/hosted-module-credentials.ts';
import {
  earliestExpiryOf,
  encodeModuleCredentialHandover,
  MODULE_CREDENTIAL_CALLERS,
  MODULE_INTERNAL_WORKLOADS,
  noProvisionedCredentials,
  providerKeyIdsOf,
  ProvisioningOutputJsonSchema,
} from '../zerops/module-credentials.mts';
import { internalWorkloadDeclarations, moduleKeyOfWorkload } from '../demo/release-internal-workloads.mts';

const workspace = path.resolve(import.meta.dirname, '../..');
const DELEGATED_CLIENT = /\bacquireDelegatedGatewayContext\b/u;
const WORKLOAD_CLIENT = /\bacquireWorkloadGatewayContext\b/u;
const ORDER = 'commerce-order';

/** Production source of one vertical: no tests, fixtures or generated build output. */
const productionSources = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) {
      return ['tests', 'node_modules', 'dist', '.output', 'testing'].includes(entry) ? [] : productionSources(absolute);
    }
    return /\.(?:ts|tsx|mts)$/u.test(entry) && !/\.test\./u.test(entry) ? [absolute] : [];
  });

const TopologySchema = Schema.Struct({
  verticals: Schema.Array(Schema.Struct({ id: Schema.String, path: Schema.String })),
});

describe('MODULE_CREDENTIAL_CALLERS', () => {
  it('names exactly the modules whose production code calls another module through delegated issuance', () => {
    const topology = Schema.decodeUnknownSync(Schema.fromJsonString(TopologySchema))(
      readFileSync(path.join(workspace, 'topology/reference-topology.json'), 'utf-8'),
    );
    const callers = topology.verticals
      .filter((vertical) =>
        productionSources(path.join(workspace, vertical.path)).some((file) =>
          DELEGATED_CLIENT.test(readFileSync(file, 'utf-8')),
        ),
      )
      .map((vertical) => vertical.id)
      .toSorted();
    expect([...MODULE_CREDENTIAL_CALLERS]).toEqual(callers);
  });
});

describe('MODULE_INTERNAL_WORKLOADS', () => {
  it('names exactly the modules whose own server acts as a workload, each only with workloads its own Actions declare', () => {
    const topology = Schema.decodeUnknownSync(Schema.fromJsonString(TopologySchema))(
      readFileSync(path.join(workspace, 'topology/reference-topology.json'), 'utf-8'),
    );
    const sourcesOf = (appId: string) => {
      const vertical = topology.verticals.find(({ id }) => id === appId);
      return vertical === undefined
        ? []
        : productionSources(path.join(workspace, vertical.path)).map((file) => readFileSync(file, 'utf-8'));
    };
    const actingModules = topology.verticals
      .filter((vertical) => sourcesOf(vertical.id).some((source) => WORKLOAD_CLIENT.test(source)))
      .map((vertical) => vertical.id)
      .toSorted();
    expect([...MODULE_INTERNAL_WORKLOADS.keys()].toSorted()).toEqual(actingModules);
    for (const [appId, workloads] of MODULE_INTERNAL_WORKLOADS) {
      // A module calls no other module's workload: every key it gets is one its own access declarations admit.
      expect(MODULE_CREDENTIAL_CALLERS).toContain(appId);
      for (const workload of workloads) {
        expect(
          sourcesOf(appId).some((source) => /\baccessWorkload\b/u.test(source) && source.includes(`'${workload}'`)),
        ).toBe(true);
      }
    }
  });
});

describe('module credential handover', () => {
  const credentials = {
    [ORDER]: Redacted.make('commerce-order-module-key'),
    'party-registry': Redacted.make('party-registry-module-key'),
  };

  it.effect('hands a process exactly the credentials of the owners it serves', () =>
    Effect.gen(function* leastPrivilegeHandover() {
      const bytes = yield* encodeModuleCredentialHandover(credentials, [ORDER, 'pricing']);
      const handover = yield* Schema.decodeEffect(Schema.fromJsonString(HostedModuleCredentialsSchema))(
        new TextDecoder().decode(bytes),
      );
      expect(Object.keys(handover.credentials)).toEqual([ORDER]);
      const order = handover.credentials[ORDER];
      expect(order === undefined ? undefined : Redacted.value(order)).toBe('commerce-order-module-key');
    }),
  );

  it.effect(
    'reports a pass with keys, their provider ids and ends, and the modules that got none, and refuses anything else',
    () =>
      Effect.gen(function* provisioningOutput() {
        const encoded = JSON.stringify({
          credentials: Object.fromEntries(
            Object.entries(credentials).map(([appId, key]) => [appId, Redacted.value(key)] as const),
          ),
          failedAppIds: ['pricing'],
          keys: {
            [ORDER]: { expiresAt: '2026-11-12T10:00:00.000Z', providerKeyId: 'order-provider-key' },
            'party-registry': { expiresAt: '2026-11-12T09:00:00.000Z', providerKeyId: 'party-provider-key' },
          },
          schemaVersion: 1,
          workloadCredentials: {
            'crm/demo.crm.party-intake/70000000-0000-4000-8000-000000000001/70000000-0000-4000-8000-000000000021':
              'crm-intake-workload-key',
          },
        });
        const decoded = yield* Schema.decodeEffect(ProvisioningOutputJsonSchema)(encoded);
        // What a host decodes it encodes back unchanged, for the next handover.
        const reencoded = yield* Schema.encodeEffect(ProvisioningOutputJsonSchema)(decoded);
        expect(yield* Schema.decodeEffect(ProvisioningOutputJsonSchema)(reencoded)).toEqual(decoded);
        expect(decoded.failedAppIds).toEqual(['pricing']);
        expect(providerKeyIdsOf(decoded)).toEqual(['order-provider-key', 'party-provider-key']);
        expect(earliestExpiryOf(decoded)).toBe(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-11-12T09:00:00.000Z')));
        for (const malformed of [
          '{}',
          '{"schemaVersion":1,"credentials":{"x":"short"},"failedAppIds":[],"keys":{}}',
          '{"schemaVersion":1,"credentials":{},"failedAppIds":[],"keys":{"x":{"providerKeyId":"p"}}}',
          '{"schemaVersion":1,"credentials":{},"failedAppIds":[],"keys":{"x":{"expiresAt":"tomorrow","providerKeyId":"p"}}}',
        ]) {
          expect(Exit.isFailure(yield* Effect.exit(Schema.decodeEffect(ProvisioningOutputJsonSchema)(malformed)))).toBe(
            true,
          );
        }
      }),
  );

  it('leaves every caller without a key when no pass ran', () => {
    const none = noProvisionedCredentials([ORDER, 'pricing']);
    expect(none.credentials).toEqual({});
    expect(none.failedAppIds).toEqual([ORDER, 'pricing']);
    expect(providerKeyIdsOf(none)).toEqual([]);
    expect(earliestExpiryOf(none)).toBeUndefined();
  });
});

const INTAKE_WORKLOAD = 'demo.crm.party-intake';

describe('internal workload declarations', () => {
  it('registers a module internal workload only while the reviewed catalogue declares it, under its own module', () => {
    const internal = new Map([['crm', [INTAKE_WORKLOAD, 'demo.crm.retired-sync']]]);
    expect(internalWorkloadDeclarations(internal, new Set([INTAKE_WORKLOAD, 'commerce.storefront-client']))).toEqual([
      { appId: 'crm', moduleKey: 'demo.crm', workloadKey: INTAKE_WORKLOAD },
    ]);
    expect(internalWorkloadDeclarations(internal, new Set())).toEqual([]);
    expect(moduleKeyOfWorkload(INTAKE_WORKLOAD)).toBe('demo.crm');
  });
});
