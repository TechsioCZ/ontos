/** The business scope is part of role identity; labels never determine authority. */
export interface ScopedRoleIdentity {
  readonly tenantId: string;
  readonly legalEntityId?: string;
  readonly roleKey: string;
}

/** Lossless tuple encoding also distinguishes a tenant role from every company role. */
export const toScopedRoleObjectId = ({ tenantId, legalEntityId, roleKey }: ScopedRoleIdentity): string =>
  `sr_${Buffer.from(JSON.stringify([tenantId, legalEntityId ?? null, roleKey]), 'utf-8').toString('base64url')}`;

/** Phase 1 agent policy uses one explicit role per principal and company. */
export const agentScopedRoleObjectId = (input: {
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly principalId: string;
}): string => toScopedRoleObjectId({ ...input, roleKey: `agent:${input.principalId}` });
