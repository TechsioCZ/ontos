export interface OptionDeletionImpactMember {
  readonly revision: number;
  readonly taskId: string;
}

export interface OptionDeletionImpactState {
  readonly impactCount: number;
  readonly impactToken: string;
}

export const buildOptionDeletionImpactState = async (
  members: readonly OptionDeletionImpactMember[],
): Promise<OptionDeletionImpactState> => {
  const serializedMembers = members
    .map(({ revision, taskId }) => `${taskId}:${revision}`)
    .join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serializedMembers));
  const impactToken = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return { impactCount: members.length, impactToken };
};
