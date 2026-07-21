const plainDecimalPattern = /^-?\d+(?:\.\d+)?$/u;

export const canonicalizeNumberValue = (input: string): string | undefined => {
  if (!plainDecimalPattern.test(input)) {
    return undefined;
  }

  const negative = input.startsWith('-');
  const unsigned = negative ? input.slice(1) : input;
  const [rawInteger = '', rawFraction = ''] = unsigned.split('.');
  const integer = rawInteger.replace(/^0+(?=\d)/u, '');
  const fraction = rawFraction.replace(/0+$/u, '');
  const significantIntegerDigits = integer === '0' ? 1 : integer.length;

  if (significantIntegerDigits > 20 || rawFraction.length > 18) {
    return undefined;
  }

  const canonicalUnsigned = fraction.length === 0 ? integer : `${integer}.${fraction}`;
  return negative && canonicalUnsigned !== '0' ? `-${canonicalUnsigned}` : canonicalUnsigned;
};
