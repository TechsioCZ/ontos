import { Result, Schema } from 'effect';

const digitWords = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
] as const;

class TailwindPrefixError extends Schema.TaggedError<TailwindPrefixError>()(
  'TailwindPrefixError',
  {
    message: Schema.String,
  }
) {}

export const tailwindPrefixForNamespace = (namespace: string): string => {
  const prefix = namespace
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, '')
    .replaceAll(/[0-9]/gu, (digit) => digitWords[Number(digit)] ?? '');
  return Result.getOrThrow(
    prefix.length === 0
      ? Result.fail(
          new TailwindPrefixError({
            message:
              'vertical namespace does not produce a valid Tailwind federation prefix',
          })
        )
      : Result.succeed(prefix)
  );
};
