import { createHash } from 'node:crypto';

/**
 * Fixed UUIDv5 namespace for every sales-demo fixture identity. Never change it: seeds, tests and the
 * agent rely on the same IDs across cold resets.
 */
export const SALES_DEMO_NAMESPACE = '5a1e5d3e-0000-5000-8000-0000000d3e70' as const;

/** Demo tenant and legal entity shared with the Siampark baseline (`pnpm demo:reset`). */
export const demoTenantId = '70000000-0000-4000-8000-000000000020' as const;
export const demoLegalEntityId = '71000000-0000-4000-8000-000000000020' as const;

const uuidBytes = (uuid: string) => Buffer.from(uuid.replaceAll('-', ''), 'hex');

const formatUuid = (bytes: Buffer) => {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** RFC 9562 UUIDv5 of `name` inside `namespace`. */
export const uuidV5 = (namespace: string, name: string): string => {
  // oxlint-disable-next-line sonarjs/hashing -- RFC 9562 UUIDv5 mandates SHA-1; IDs are public fixture identities.
  const hash = createHash('sha1').update(uuidBytes(namespace)).update(name, 'utf-8').digest().subarray(0, 16);
  // Version 5 in the high nibble of byte 6, RFC 4122 variant in the top two bits of byte 8.
  hash.writeUInt8((hash.readUInt8(6) % 16) + 0x50, 6);
  hash.writeUInt8((hash.readUInt8(8) % 64) + 0x80, 8);
  return formatUuid(hash);
};

/**
 * Deterministic demo ID, e.g. `demoId('workforce.employee', 'obchod')` or
 * `demoId('party.customer', 'ico-27082440')`. Use `<owner>.<resource>` as the namespace and a stable
 * human key; never generate random IDs in seeds.
 */
export const demoId = (namespace: string, key: string): string => uuidV5(SALES_DEMO_NAMESPACE, `${namespace}:${key}`);
