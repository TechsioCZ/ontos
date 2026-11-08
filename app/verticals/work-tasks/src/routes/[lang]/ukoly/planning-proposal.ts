// A project plan sent from the planning panel can be committed, parked for approval or refused.
import { Equal, Option, Schema } from 'effect';

/** The answer to one planning command; a proposal changed nothing yet and `message` says so. */
export type PlanOutcome =
  | { readonly ok: true }
  | { readonly message: string; readonly ok: false; readonly proposed: boolean };

/** The plan is saved: the panel closes. */
export const PlanCommittedSchema = Schema.TaggedStruct('PlanCommitted', {});
/** The plan waits for approval and changed nothing yet: the panel says so and holds this plan back. */
export const PlanProposedSchema = Schema.TaggedStruct('PlanProposed', { message: Schema.String });
/** The plan was refused: the panel shows why and can send it again. */
export const PlanFailedSchema = Schema.TaggedStruct('PlanFailed', { message: Schema.String });
/** What the panel does with one answer. */
export const PlanAnswerSchema = Schema.Union([PlanCommittedSchema, PlanProposedSchema, PlanFailedSchema]);
export type PlanAnswer = typeof PlanAnswerSchema.Type;

export const planAnswer = (outcome: PlanOutcome): PlanAnswer => {
  if (outcome.ok) {
    return PlanCommittedSchema.make({});
  }
  return outcome.proposed
    ? PlanProposedSchema.make({ message: outcome.message })
    : PlanFailedSchema.make({ message: outcome.message });
};

/**
 * The proposal the current plan repeats exactly, if any. Sending that plan again would only park a duplicate, so the
 * panel shows it as pending instead.
 */
export const pendingProposal = <P extends { readonly command: unknown }>(
  proposed: Option.Option<P>,
  plan: Option.Option<P['command']>,
): Option.Option<P> =>
  proposed.pipe(Option.filter((proposal) => Option.isSome(plan) && Equal.equals(proposal.command, plan.value)));
