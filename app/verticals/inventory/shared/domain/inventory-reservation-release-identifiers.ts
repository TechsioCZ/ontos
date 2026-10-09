import { Schema } from 'effect';

export const ReservationReleaseEffectIdSchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('ReservationReleaseEffectId'));
