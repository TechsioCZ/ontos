/** A platform approval submission refused at its native boundary; the message is safe Czech tool text. */
import { Data } from 'effect';

export class ProposalRefused extends Data.TaggedError('ProposalRefused')<{
  readonly cause?: Error;
  readonly message: string;
}> {}
