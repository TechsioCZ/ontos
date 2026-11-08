/** Reviewed historical identities only; identical content is not a general migration deduplication rule. */
export const CORE_MIGRATION_EQUIVALENCES = [
  {
    demo: '20261024090000_trusted-gateway-scope',
    hash: '2b682c3cbb2b9bbf6888134f707d946a96a35c2c9b2889ba5810f81367eeadcd',
    history: 'core',
    main: '20261020062648_trusted-gateway-scope',
  },
  {
    demo: '20261024090100_dedicated-identity-core-policies',
    hash: 'c48caac1577ba5ef2b8f8c5da2c055132c9b1473ee74e8e9f199749c90a80aed',
    history: 'core',
    main: '20261020063004_dedicated-identity-core-policies',
  },
  {
    demo: '20261024090200_legal-entity-scope',
    hash: 'bf1d792532f81002d15727a7903ca2fd00dbfaca00936aa6aee86632557feb3e',
    history: 'core',
    main: '20261020113601_legal-entity-scope',
  },
] as const;
