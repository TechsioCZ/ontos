import { fileURLToPath } from 'node:url';

export const PARTY_MIGRATION_MANIFESTS = [
  {
    folder: fileURLToPath(new URL('../drizzle-contacts/', import.meta.url)),
    history: 'contacts',
    snapshots: [
      ['20261020063912_contacts-gateway-scope-rls', '62b49b1b76e1284b9a72e9fbebe132bf71ff55a530c40ea3c8a5a0f345a59b35'],
      ['20261024090301_contacts-gateway-scope-rls', '0feaa22d7a9e38f29393c6c80843fcfcb057a22e6e3cbf83b5c13a945cd12745'],
      [
        '20261027230000_contacts-migration-equivalence',
        '356f304c54996e04244d460f6bd9e12bb4b146aba228cdd733754e019e4a3b70',
      ],
    ],
  },
  {
    folder: fileURLToPath(new URL('../drizzle/', import.meta.url)),
    history: 'party',
    snapshots: [
      ['20261020063911_party-gateway-scope-rls', 'bbbf76ba634732410a7d7b4ef8061db6d8afdcc8ace1ac4585bc7eaff0d9d899'],
      ['20261020113551_legal-entity-scope', 'fb44b8f2ee609b0ba3d32aa6c75c8ec6380d5cc105f2585ad42b19d3f94b7fae'],
      ['20261024090300_party-gateway-scope-rls', 'b4a1c665969c67a0d047be76c6224785f1c2d3ef37c8dd44373cc4c6650e485c'],
      ['20261024090400_legal-entity-scope', '4e764cdd2e43f7b2b06a587d996f8fc53ea93f654aa76b39416233bbc59f6716'],
      [
        '20261027230000_party-migration-equivalence',
        'ba5e75c0db26edfb67d0a2fdde550de55e73622859dbfd132778fbef0d44b625',
      ],
    ],
  },
] as const;
