import { Schema } from 'effect';

/** Why the Action refused: the fields it names are where the person reads it. */
export class CreateProjectRefused extends Schema.TaggedError<CreateProjectRefused>()('CreateProjectRefused', {
  reason: Schema.Literals([
    'conflict',
    'forbidden',
    'ineligibleOwner',
    'invalid',
    'uncertain',
    'unavailable',
    'prefixTaken',
  ]),
}) {}
