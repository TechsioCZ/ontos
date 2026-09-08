import { Effect, Match, Predicate, Schema } from 'effect';
const error = Predicate.isError(value);
const tagged = Predicate.isTagged(value, 'Missing');
const decoded = Schema.is(Missing)(value);
const recovered = operation.pipe(Effect.catchTag('Missing', () => Effect.void));
const matched = Match.value(value).pipe(Match.tag('Missing', () => true), Match.orElse(() => false));
const lexical = 'instanceof';
const grammar = /\binstanceof\b/u;
