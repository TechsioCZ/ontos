// Optional country/trunk prefixes are domain normalization, not SQLSTATE probes.
export const phoneDigits = (value: string): string =>
  value.replaceAll(/\D/gu, '').replace(/^(?:00)?420(?=\d{9}$)/u, '');

export const optionalTrunk = (value: string): string => value.replace(/^(?:00){0,1}420/u, '');
export const repeatedTrunk = (value: string): string => value.replace(/^(?:00)*420/u, '');
export const optionalDigit = (value: string): string => value.replace(/^4[02]?420/u, '');

const internationalPrefix = new RegExp('^(?:00)?420(?=\\d{9}$)', 'u');
export const runtimePhonePrefix = (value: string): string => value.replace(internationalPrefix, '');
