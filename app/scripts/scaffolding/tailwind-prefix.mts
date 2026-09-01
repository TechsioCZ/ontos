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

export const tailwindPrefixForNamespace = (namespace: string): string => {
  const prefix = namespace
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, '')
    .replaceAll(/[0-9]/gu, (digit) => digitWords[Number(digit)] ?? '');
  if (prefix.length === 0) {
    throw new Error('vertical namespace does not produce a valid Tailwind federation prefix');
  }
  return prefix;
};
