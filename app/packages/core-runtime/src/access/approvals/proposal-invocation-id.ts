import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { ProposalIdSchema } from '../ids.ts';
import type { ProposalId, TenantId } from '../ids.ts';
import type { ActionInvocationRef } from './execution.ts';

/**
 * Name-based UUIDv8 over SHA-256 (RFC 9562, Appendix B.2) with the tenant UUID as namespace and the
 * immutable Action invocation ID as name (O90): one invocation always names the same proposal.
 */
export const proposalIdForInvocation = (tenantId: TenantId, actionInvocationId: ActionInvocationRef): ProposalId => {
  const namespace = tenantId.replaceAll('-', '');
  const namespaceBytes = Uint8Array.from(
    Array.from({ length: 16 }, (_, index) => Number.parseInt(namespace.slice(index * 2, index * 2 + 2), 16)),
  );
  const nameBytes = utf8ToBytes(actionInvocationId);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes);
  input.set(nameBytes, namespaceBytes.length);
  const digest = sha256(input);
  const bytes = Uint8Array.from(digest.slice(0, 16));
  bytes[6] = ((bytes[6] ?? 0) % 16) + 128;
  bytes[8] = ((bytes[8] ?? 0) % 64) + 128;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return ProposalIdSchema.make(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  );
};
