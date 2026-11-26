import { Schema } from 'effect';

import { ApprovedRuleKeySchema, AudienceSlotKeySchema } from './vocabulary.ts';
import type { AudienceSlotKey } from './vocabulary.ts';

/**
 * Audience policy of one approved type (#1395, PO 2A). Every recipient is evaluated individually, so a partial
 * result is normal. An indivisible all-or-none group is an explicit per-type exception that names the approved rule
 * behind it and the exact audience slots it covers; nothing is atomic by default and nothing is inferred.
 */
export const AudiencePolicySchema = Schema.Union([
  Schema.Struct({ mode: Schema.Literal('INDIVIDUAL') }),
  Schema.Struct({
    approvalRuleKey: ApprovedRuleKeySchema,
    mode: Schema.Literal('INDIVISIBLE'),
    slotKeys: Schema.NonEmptyArray(AudienceSlotKeySchema),
  }),
]);
export type AudiencePolicy = typeof AudiencePolicySchema.Type;

/** One audience slot member and whether it can still be handed off. */
export interface GroupMember {
  readonly ready: boolean;
  readonly slotKey: AudienceSlotKey;
}

/** Slot keys an audience policy binds together; empty for the default individual policy. */
export const groupSlotKeys = (audience: AudiencePolicy): readonly AudienceSlotKey[] =>
  audience.mode === 'INDIVISIBLE' ? audience.slotKeys : [];

export const isGroupMember = (audience: AudiencePolicy, slotKey: AudienceSlotKey) =>
  groupSlotKeys(audience).includes(slotKey);

/**
 * An indivisible group is complete only when every slot it covers has at least one member and every member is
 * ready. An individual audience is never an incomplete group. Evaluated before the first irreversible boundary:
 * an incomplete group prepares no group message, and it never claims to undo an effect already proven elsewhere.
 */
export const isGroupComplete = (audience: AudiencePolicy, members: readonly GroupMember[]) =>
  groupSlotKeys(audience).every((slotKey) => {
    const slotMembers = members.filter((member) => member.slotKey === slotKey);
    return slotMembers.length > 0 && slotMembers.every((member) => member.ready);
  });
