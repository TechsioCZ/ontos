import { Schema } from 'effect';

class UltramodernCommandError extends Schema.TaggedError<UltramodernCommandError>()(
  'UltramodernCommandError',
  { reason: Schema.String }
) {}

export const ultramodernCommandFailure = (
  reason: string
): UltramodernCommandError => new UltramodernCommandError({ reason });
