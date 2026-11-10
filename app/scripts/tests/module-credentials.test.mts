import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { Effect, Exit, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { HostedModuleCredentialsSchema } from '../../packages/core-runtime/src/auth/hosted-module-credentials.ts';
import {
  encodeModuleCredentialHandover,
  MODULE_CREDENTIAL_CALLERS,
  noProvisionedCredentials,
  ProvisioningOutputJsonSchema,
} from '../zerops/module-credentials.mts';

const workspace = path.resolve(import.meta.dirname, '../..');
const DELEGATED_CLIENT = /\bacquireDelegatedGatewayContext\b/u;
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

  it.effect('reports a pass with keys, provider key ids and the modules that got none, and refuses anything else', () =>
    Effect.gen(function* provisioningOutput() {
      const encoded = yield* Schema.encodeUnknownEffect(ProvisioningOutputJsonSchema)({
        credentials,
        failedAppIds: ['pricing'],
        providerKeyIds: ['order-provider-key', 'party-provider-key'],
        schemaVersion: 1,
      });
      const decoded = yield* Schema.decodeEffect(ProvisioningOutputJsonSchema)(encoded);
      expect(decoded.failedAppIds).toEqual(['pricing']);
      expect(decoded.providerKeyIds).toEqual(['order-provider-key', 'party-provider-key']);
      for (const malformed of [
        '{}',
        '{"schemaVersion":1,"credentials":{"x":"short"},"failedAppIds":[],"providerKeyIds":[]}',
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
    expect(none.providerKeyIds).toEqual([]);
  });
});
