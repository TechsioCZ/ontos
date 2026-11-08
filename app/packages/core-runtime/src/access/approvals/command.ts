import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { Predicate, Result, Schema } from 'effect';
import { Hex } from 'effect/encoding';

import type { CommandDigest } from '../ids.ts';
import { CapabilityKeySchema, CommandDigestSchema, RecordKeySchema } from '../ids.ts';
import { CommandNotCanonicalError } from './errors.ts';

/**
 * The exact command a proposal freezes: one capability, at most one record and one opaque module
 * payload. The payload stays the module's own document; the digest binds its canonical form, so an
 * edited command never passes for the approved one while a re-serialised or re-stored copy of the
 * same document still does (R2-L2, guarantee 5).
 */
export const FrozenCommandSchema = Schema.Struct({
  capabilityKey: CapabilityKeySchema,
  payload: Schema.Json,
  target: Schema.optionalKey(RecordKeySchema),
});
export type FrozenCommand = typeof FrozenCommandSchema.Type;

/** Extra keys are refused, so a caller cannot smuggle an unbound field past the frozen digest. */
const FROZEN_COMMAND_PARSE_OPTIONS = { onExcessProperty: 'error' } as const;
const decodeFrozenCommand = Schema.decodeUnknownResult(FrozenCommandSchema, FROZEN_COMMAND_PARSE_OPTIONS);
const decodeCommandDigest = Schema.decodeResult(CommandDigestSchema);

const notCanonical = (reason: string): Result.Result<never, CommandNotCanonicalError> =>
  Result.fail(new CommandNotCanonicalError({ code: 'command_not_canonical', reason }));

/** RFC 8785 orders object keys by UTF-16 code units, which is the `<` operator on strings. */
const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
};

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

const SHORT_ESCAPES = new Map<number, string>([
  [0x08, String.raw`\b`],
  [0x09, String.raw`\t`],
  [0x0a, String.raw`\n`],
  [0x0c, String.raw`\f`],
  [0x0d, String.raw`\r`],
]);

/**
 * RFC 8785 string form: only the quotation mark, the reverse solidus and the C0 controls are
 * escaped, and the five controls with a short escape keep it. Every other character stays literal,
 * so the digest never depends on a host's choice of Unicode escaping.
 *
 * A string that is not well formed — a lone surrogate — is refused instead of encoded: the UTF-8
 * byte encoder replaces it with U+FFFD, so two different payloads would otherwise share one digest
 * (R3b-N9).
 */
const encodeJsonString = (value: string): Result.Result<string, CommandNotCanonicalError> => {
  if (!value.isWellFormed()) {
    return notCanonical('A command payload cannot contain a lone surrogate half');
  }
  let encoded = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    const shortEscape = SHORT_ESCAPES.get(code);
    if (character === '"') {
      encoded += String.raw`\"`;
    } else if (character === '\\') {
      encoded += String.raw`\\`;
    } else if (shortEscape !== undefined) {
      encoded += shortEscape;
    } else if (code < 0x20) {
      encoded += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      encoded += character;
    }
  }
  return Result.succeed(`${encoded}"`);
};

/** RFC 8785 number form is the ECMAScript `Number::toString` text; only -0 and non-finite differ. */
const encodeJsonNumber = (value: number): Result.Result<string, CommandNotCanonicalError> => {
  if (!Number.isFinite(value)) {
    return notCanonical('A command payload cannot contain a non-finite number');
  }
  return Result.succeed(Object.is(value, -0) ? '0' : String(value));
};

/**
 * Serialises one decoded JSON value in RFC 8785 canonical form: object members in code-unit order,
 * no insignificant whitespace, ECMAScript numbers and minimal string escapes. Anything the format
 * cannot represent — a cycle, `undefined`, a function, a symbol or a non-finite number — is a typed
 * refusal rather than a thrown defect, because a caller's payload is untrusted input (R2-L2).
 */
const encodeCanonicalJson = (
  value: Schema.Json,
  seen: WeakSet<object>,
): Result.Result<string, CommandNotCanonicalError> => {
  if (value === null) {
    return Result.succeed('null');
  }
  if (Predicate.isBoolean(value)) {
    return Result.succeed(value ? 'true' : 'false');
  }
  if (Predicate.isString(value)) {
    return encodeJsonString(value);
  }
  if (Predicate.isNumber(value)) {
    return encodeJsonNumber(value);
  }
  if (seen.has(value)) {
    return notCanonical('A command payload must not contain cycles');
  }
  seen.add(value);
  const encoded = isJsonArray(value)
    ? Result.all(value.map((item) => encodeCanonicalJson(item, seen))).pipe(
        Result.map((items) => `[${items.join(',')}]`),
      )
    : Result.all(
        Object.entries(value)
          .toSorted(([left], [right]) => compareCodeUnits(left, right))
          .map(([key, member]) =>
            encodeJsonString(key).pipe(
              Result.flatMap((encodedKey) =>
                encodeCanonicalJson(member, seen).pipe(Result.map((encodedMember) => `${encodedKey}:${encodedMember}`)),
              ),
            ),
          ),
      ).pipe(Result.map((members) => `{${members.join(',')}}`));
  seen.delete(value);
  return encoded;
};

const digestOf = (canonical: string): Result.Result<CommandDigest, CommandNotCanonicalError> =>
  decodeCommandDigest(Hex.encode(sha256(utf8ToBytes(canonical)))).pipe(
    Result.mapError(
      () =>
        new CommandNotCanonicalError({
          code: 'command_not_canonical',
          reason: 'The frozen digest is not a SHA-256 hex string',
        }),
    ),
  );

/**
 * Freezes the command a proposal asks to execute into one SHA-256 digest of its RFC 8785 canonical
 * JSON form. Execution recomputes the digest from the command it is about to run, so a command that
 * changed after the person approved it is refused instead of executed, while the same document in
 * another key order or after a JSONB round trip still matches (guarantee 5, R2-L2).
 */
export const freezeCommand = (command: FrozenCommand): Result.Result<CommandDigest, CommandNotCanonicalError> => {
  const decoded = decodeFrozenCommand(command);
  if (Result.isFailure(decoded)) {
    return notCanonical(decoded.failure.message);
  }
  return encodeCanonicalJson(decoded.success, new WeakSet()).pipe(Result.flatMap(digestOf));
};
