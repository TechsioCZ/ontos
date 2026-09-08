import type { ReactElement } from 'react';
import { Schema } from 'effect';

// Derived UI vocabulary — the codec is the authority.
export const ButtonTone = Schema.Literals(['danger', 'neutral', 'primary']);
export type ButtonTone = typeof ButtonTone.Type;

// Not unions of string literals.
export type ToneMap = Record<ButtonTone, string>;
export type ToneOrNothing = ButtonTone | undefined;
export type ToneOrNull = ButtonTone | null;

export function Button(props: { readonly tone: ButtonTone }): ReactElement {
  return <button data-tone={props.tone} type="button" />;
}
