import { fileURLToPath } from 'node:url';

export const CORE_MIGRATION_MANIFEST = {
  folder: fileURLToPath(new URL('../drizzle/', import.meta.url)),
  history: 'core',
  snapshots: [
    ['20261020062648_trusted-gateway-scope', 'dfe987ef68fd964bd8d80bc4ac7fe57e6fa150344a7915c712a6e406779a6b77'],
    [
      '20261020063004_dedicated-identity-core-policies',
      '1d20c36f358dab93af6827522c0b17d6a1811ade691fa1ec529647c71e576982',
    ],
    ['20261020113601_legal-entity-scope', '0552f259277b4e6e62f610d52e76aa0d872a9a7687cec8192f4a785c332b0d7e'],
    ['20261024090000_trusted-gateway-scope', 'ceec7e4714bb131040664473456faeecd22fc55919bd849ed70d005d68c6b9a8'],
    [
      '20261024090100_dedicated-identity-core-policies',
      '4bea0e47f8cd5c62652ccbd1ad536c8370d0313935983b8e74287f6f4ac36c8a',
    ],
    ['20261024090200_legal-entity-scope', 'a9a034dc460dba030f13be5af1bb9b392096d4a8361fdc5a2daf98367cc83446'],
    ['20261027230000_core-migration-equivalence', '37293a92553c72c33f2e04442f1b5e7712edb6f7e1c14f3fcde54c8c630e9842'],
    ['20261024223832_gateway-identity-attestation', 'ff79f56d16dc3458183afea894b027bc8f4970af3520b26b1060ac54d10c3d35'],
  ],
} as const;
