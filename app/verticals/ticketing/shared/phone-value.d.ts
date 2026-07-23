export type PhoneValueValidationFailure = 'control_character' | 'line_separator' | 'too_long';
export type PhoneValueValidationResult = {
    readonly ok: true;
    readonly value: string | null;
} | {
    readonly failure: PhoneValueValidationFailure;
    readonly ok: false;
};
export declare const validatePhoneValue: (value: string | null) => PhoneValueValidationResult;
export declare const phoneTelHref: (value: string) => string;
