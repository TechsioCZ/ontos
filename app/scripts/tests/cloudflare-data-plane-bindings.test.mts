import { readFileSync } from 'node:fs';

import { Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { createCloudflareDataPlaneBindings } from '../../packages/shared-contracts/tooling/modern-config.ts';
import { PRICE_GROUP_CATALOG_SERVICE_BINDING } from '../../verticals/commerce-customer-context/shared/deployment-paths.ts';

const HYPERDRIVE_ID = 'ULTRAMODERN_CLOUDFLARE_HYPERDRIVE_ID';
const SPICEDB_VPC_SERVICE_ID = 'ULTRAMODERN_CLOUDFLARE_SPICEDB_VPC_SERVICE_ID';
const HYPERDRIVE_CONFIG = 'hyperdrive-id';
const SPICEDB_VPC_SERVICE = 'vpc-service-id';

const reader =
  (values: Readonly<Record<string, string>>) =>
  (name: string): string | undefined =>
    values[name];

it('binds every Worker to PostgreSQL through Hyperdrive and to SpiceDB through its Workers VPC service', () => {
  expect(
    createCloudflareDataPlaneBindings(
      reader({
        [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG,
        [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE,
      }),
    ),
  ).toEqual({
    vpcServices: [{ binding: 'SPICEDB', serviceId: SPICEDB_VPC_SERVICE }],
    wrangler: { hyperdrive: [{ binding: 'HYPERDRIVE', id: HYPERDRIVE_CONFIG }] },
  });
});

it.each([
  [HYPERDRIVE_ID, { [SPICEDB_VPC_SERVICE_ID]: SPICEDB_VPC_SERVICE }],
  [SPICEDB_VPC_SERVICE_ID, { [HYPERDRIVE_ID]: HYPERDRIVE_CONFIG }],
] as const)('refuses a Worker build without %s', (name, values) => {
  expect(() => createCloudflareDataPlaneBindings(reader(values))).toThrow(
    `${name} is required for a Cloudflare Worker build`,
  );
});

const readDocument = (name: string) => readFileSync(new URL(`../../topology/${name}`, import.meta.url), 'utf-8');

it("names Commerce's Price Group Catalog binding exactly as the topology and placement bind it", () => {
  const TopologySchema = Schema.Struct({
    verticals: Schema.Array(
      Schema.Struct({
        backendFederation: Schema.optionalKey(
          Schema.Struct({
            executionSurfaces: Schema.Struct({
              cloudflare: Schema.Struct({ workerDispatch: Schema.Struct({ serviceBinding: Schema.String }) }),
            }),
          }),
        ),
        id: Schema.String,
      }),
    ),
  });
  const PlacementSchema = Schema.Struct({
    unitServiceBindings: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  });
  const topology = Schema.decodeUnknownSync(Schema.fromJsonString(TopologySchema))(
    readDocument('reference-topology.json'),
  );
  const placement = Schema.decodeUnknownSync(Schema.fromJsonString(PlacementSchema))(
    readDocument('cloudflare-placement.json'),
  );
  // The Worker config emits the target's topology binding; Commerce's routed fetch must ask for it.
  expect(placement.unitServiceBindings['commerce-customer-context']).toContain('price-group-catalog');
  expect(
    topology.verticals.find(({ id }) => id === 'price-group-catalog')?.backendFederation?.executionSurfaces.cloudflare
      .workerDispatch.serviceBinding,
  ).toBe(PRICE_GROUP_CATALOG_SERVICE_BINDING);
});
