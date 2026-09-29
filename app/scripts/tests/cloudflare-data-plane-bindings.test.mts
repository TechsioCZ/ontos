import { expect, it } from 'effect-rstest';

import { createCloudflareDataPlaneBindings } from '../../packages/shared-contracts/tooling/modern-config.ts';

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
