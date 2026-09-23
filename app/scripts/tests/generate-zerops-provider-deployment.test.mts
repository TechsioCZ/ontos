import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { generateZeropsProviderDeployment } from '../generate-zerops-provider-deployment.mts';

const root = path.resolve(import.meta.dirname, '../..');

const TopologySchema = Schema.fromJsonString(
  Schema.Struct({
    verticals: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        moduleFederation: Schema.Struct({ manifestUrl: Schema.String }),
        package: Schema.String,
        path: Schema.String,
      }),
    ),
  }),
);

it.effect('reproduces the checked-in provider setups from topology and preserves other services', () =>
  Effect.gen(function* testProviderReproducer() {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(path.join(root, 'zerops.yaml'));
    const topologySource = yield* fs.readFileString(path.join(root, 'topology/reference-topology.json'));
    const topology = yield* Schema.decodeUnknownEffect(TopologySchema)(topologySource);
    expect(yield* generateZeropsProviderDeployment(source, topology)).toBe(source);
    for (const vertical of topology.verticals) {
      expect(source).toContain(`  - setup: '${vertical.id}'\n`);
      expect(source).toContain(
        `--app '${vertical.id}' --package '${vertical.package}' --package-dir '${vertical.path}'`,
      );
    }
    expect(source).toContain("  - setup: 'migrator'\n");
    expect(source).toContain("  - setup: 'shellsuperapp'\n");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect('rejects duplicate provider identity and port instead of emitting ambiguous YAML', () =>
  Effect.gen(function* invalidDuplicates() {
    const vertical = {
      id: 'ledger',
      moduleFederation: { manifestUrl: 'http://localhost:4140/mf-manifest.json' },
      package: '@app/ledger',
      path: 'verticals/ledger',
    };
    const source = "zerops:\n  - setup: 'ledger'\n\n  - setup: 'shellsuperapp'\n";
    expect(
      (yield* Effect.flip(generateZeropsProviderDeployment(source, { verticals: [vertical, vertical] }))).reason,
    ).toBe('Duplicate topology provider: ledger');
    expect(
      (yield* Effect.flip(
        generateZeropsProviderDeployment(source, {
          verticals: [vertical, { ...vertical, id: 'invoice', package: '@app/invoice', path: 'verticals/invoice' }],
        }),
      )).reason,
    ).toBe('Duplicate topology provider port: 4140');
  }),
);

it.effect('rejects malformed identity, source boundaries, and provider drift', () =>
  Effect.gen(function* invalidProvider() {
    const vertical = {
      id: 'ledger',
      moduleFederation: { manifestUrl: 'http://localhost:4140/mf-manifest.json' },
      package: '@app/ledger',
      path: 'verticals/ledger',
    };
    const source = "zerops:\n  - setup: 'ledger'\n\n  - setup: 'shellsuperapp'\n";
    expect(
      (yield* Effect.flip(
        generateZeropsProviderDeployment(source, { verticals: [{ ...vertical, path: 'verticals/other' }] }),
      )).reason,
    ).toBe('Invalid topology provider identity: ledger');
    expect((yield* Effect.flip(generateZeropsProviderDeployment('zerops:\n', { verticals: [vertical] }))).reason).toBe(
      'Missing legacy provider section or Shell boundary',
    );
    const generated = yield* generateZeropsProviderDeployment(source, { verticals: [vertical] });
    expect(yield* generateZeropsProviderDeployment(generated, { verticals: [vertical] })).toBe(generated);
    expect(
      yield* generateZeropsProviderDeployment(generated.replace("PORT: '4140'", "PORT: '4141'"), {
        verticals: [vertical],
      }),
    ).toBe(generated);
  }),
);

it.effect('requires the publisher-owned composition snapshot only for Customer Context', () =>
  Effect.gen(function* compositionSnapshotPreflight() {
    const customerContext = {
      id: 'commerce-customer-context',
      moduleFederation: { manifestUrl: 'http://localhost:4101/mf-manifest.json' },
      package: '@app/commerce-customer-context',
      path: 'verticals/commerce-customer-context',
    };
    const partyRegistry = {
      id: 'party-registry',
      moduleFederation: { manifestUrl: 'http://localhost:4102/mf-manifest.json' },
      package: '@app/party-registry',
      path: 'verticals/party-registry',
    };
    const source = "zerops:\n  - setup: 'commerce-customer-context'\n\n  - setup: 'shellsuperapp'\n";
    const generated = yield* generateZeropsProviderDeployment(source, {
      verticals: [customerContext, partyRegistry],
    });
    const customerContextStart = generated.indexOf("  - setup: 'commerce-customer-context'");
    const partyRegistryStart = generated.indexOf("  - setup: 'party-registry'");
    const customerContextBlock = generated.slice(customerContextStart, partyRegistryStart);
    const partyRegistryBlock = generated.slice(
      partyRegistryStart,
      generated.indexOf('  # </generated', partyRegistryStart),
    );

    expect(customerContextBlock).toContain('test -n "$ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON"');
    expect(customerContextBlock).not.toContain('ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON:');
    expect(partyRegistryBlock).not.toContain('ONTOS_ACTIVE_APPLICATION_COMPOSITION_SNAPSHOT_JSON');
  }),
);
