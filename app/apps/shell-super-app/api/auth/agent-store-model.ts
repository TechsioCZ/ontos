import { ConfigureAgentAuditEvidenceSchema } from '@app/core-runtime';
import type { AgentModuleGrant, AgentWritePolicy } from '@app/shared-contracts/agent-access';
import { Option, Schema } from 'effect';

export interface AgentProfile {
  readonly description: string | null;
  readonly hasProfile: boolean;
  readonly modules: readonly AgentModuleGrant[];
  readonly ownerPrincipalId: string | null;
  /** Fail-closed effective cap, not a configured policy when hasProfile is false. */
  readonly writePolicy: AgentWritePolicy;
}

/** No audited profile means no selected modules and no write authority. The UI labels it "bez profilu". */
export const DEFAULT_AGENT_PROFILE: AgentProfile = {
  description: null,
  hasProfile: false,
  modules: [],
  ownerPrincipalId: null,
  writePolicy: 'read_only',
};
const AuditRowSchema = Schema.Struct({ evidence: Schema.Unknown });
export type AgentProfileAuditRow = typeof AuditRowSchema.Type;
const TargetSchema = Schema.Struct({
  legalEntityId: ConfigureAgentAuditEvidenceSchema.fields.legalEntityId,
  targetPrincipalId: ConfigureAgentAuditEvidenceSchema.fields.targetPrincipalId,
});

/** Only native, exact-company Action evidence creates a profile. No seed or key-name inference. */
export const foldAgentProfiles = (
  legalEntityId: string,
  principalIds: readonly string[],
  evidenceOldestFirst: readonly AgentProfileAuditRow[],
): ReadonlyMap<string, AgentProfile> => {
  const wanted = new Set(principalIds);
  const profiles = new Map(principalIds.map((principalId) => [principalId, DEFAULT_AGENT_PROFILE]));
  const revisions = new Map<string, number>();
  for (const row of evidenceOldestFirst) {
    const target = Schema.decodeUnknownOption(TargetSchema)(row.evidence);
    if (
      Option.isNone(target) ||
      !wanted.has(target.value.targetPrincipalId) ||
      target.value.legalEntityId !== legalEntityId
    ) {
      continue;
    }
    const { targetPrincipalId } = target.value;
    const version = Schema.decodeUnknownOption(
      Schema.Struct({ revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
    )(row.evidence);
    const revision = Option.isSome(version) ? version.value.revision : Number.POSITIVE_INFINITY;
    if (revision > (revisions.get(targetPrincipalId) ?? 0)) {
      revisions.set(targetPrincipalId, revision);
      const parsed = Schema.decodeUnknownOption(ConfigureAgentAuditEvidenceSchema)(row.evidence);
      // Even out-of-order older valid rows cannot revive a corrupt authoritative revision.
      if (Option.isNone(parsed)) {
        profiles.set(targetPrincipalId, DEFAULT_AGENT_PROFILE);
      } else {
        const evidence = parsed.value;
        profiles.set(targetPrincipalId, {
          description: evidence.description,
          hasProfile: true,
          modules: evidence.modules,
          ownerPrincipalId: evidence.ownerPrincipalId,
          writePolicy: evidence.writePolicy,
        });
      }
    }
  }
  return profiles;
};
