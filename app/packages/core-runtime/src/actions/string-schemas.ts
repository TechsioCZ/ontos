import { Schema } from 'effect';

export const nonEmptyString = Schema.String.check(Schema.isMinLength(1));

/**
 * Control characters are what let a caller forge a log record or split an audit field. The contract in
 * `@app/shared-contracts` bounds the same header by length only, so anything else printable is allowed.
 */
const containsControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.codePointAt(index) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
};

/**
 * Caller-supplied transport identifiers (`x-correlation-id`, `x-trace-id`) are audit metadata: they are
 * written verbatim into `action_invocations` and structured log annotations, so they are bounded here as
 * well as at the HTTP seam. The bound is a maximum length plus rejection of control characters, which are
 * what would let a caller forge a log record or smuggle a newline into an audit field. The bound matches the contract already used for the same header in
 * `@app/shared-contracts` (`x-correlation-id`, 1..200).
 */
export const transportIdentifier = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.makeFilter((value) => (containsControlCharacter(value) ? 'must not contain control characters' : undefined)),
);

// Effect 4 requires one literal brand key; the parameter keeps Schema.brand's own constraint.
export const decodedStringBrand = <Brand extends string>(
  schema: Schema.String,
  brand: Parameters<typeof Schema.brand<Brand>>[0],
) => schema.pipe(Schema.brand<Brand>(brand), Schema.decodeTo(Schema.String));

export const TargetModuleKeySchema = decodedStringBrand(nonEmptyString, 'TargetModuleKey');
export const TargetResourceIdSchema = decodedStringBrand(nonEmptyString, 'TargetResourceId');
