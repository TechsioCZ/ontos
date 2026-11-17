import { Effect, Schema } from 'effect';

/**
 * The one failure vocabulary of the native Catalog media-ordering proof. Each `stage` names the step
 * of the owner/receiver handshake that refused, so a failed proof reports where it stopped instead of
 * surfacing an opaque defect. It lives beside the proof rather than inside it because the proof file
 * owns the shared owner-build Context service.
 */
export class MediaOrderingNativeFailure extends Schema.TaggedError<MediaOrderingNativeFailure>()(
  'MediaOrderingNativeFailure',
  { stage: Schema.String },
) {}

/** The failure for one refused `stage`, ready to offer to a queue or fail with. */
export const mediaOrderingFailure = (stage: string) => new MediaOrderingNativeFailure({ stage });

/** Continues when `condition` holds, and otherwise refuses naming `stage`. */
export const requireMediaOrderingCondition = (condition: boolean, stage: string) =>
  condition ? Effect.void : Effect.fail(mediaOrderingFailure(stage));
