import { Schema } from 'effect';

/** A won message older than the opportunity's later move out of WON: it no longer drafts an invoice. */
export class OpportunityNoLongerWon extends Schema.TaggedError<OpportunityNoLongerWon>()('OpportunityNoLongerWon', {
  /** The Sales Pipeline revision at which the opportunity left WON. */
  leftAtRevision: Schema.Int,
}) {}
