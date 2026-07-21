export interface EmailValueInvalid {
  readonly _tag: 'Invalid';
  readonly message: string;
}
export interface EmailValueValid {
  readonly _tag: 'Valid';
  readonly normalizedValue: string;
  readonly value: string;
}
export interface EmailValueEmpty {
  readonly _tag: 'Empty';
}
export type ParsedEmailValue = EmailValueEmpty | EmailValueInvalid | EmailValueValid;
export declare const parseEmailValue: (input: string) => ParsedEmailValue;
export declare const emailMailtoHref: (value: string) => string | undefined;
