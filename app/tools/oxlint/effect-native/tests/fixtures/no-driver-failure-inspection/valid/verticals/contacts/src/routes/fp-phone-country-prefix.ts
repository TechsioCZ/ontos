// A Czech phone number may carry its country prefix as `00420` or `420`. The optional `(?:00)?` group is a phone
// prefix, not a SQLSTATE class: a SQLSTATE class test never makes its class optional.
const NON_DIGITS = /\D/gu;

export const phoneDigits = (value: string): string =>
  value.replaceAll(NON_DIGITS, '').replace(/^(?:00)?420(?=\d{9}$)/u, '');
