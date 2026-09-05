// A literal union that is not the *whole* right-hand side of a plain alias is not this finding.
export type Handler = (kind: 'draft' | 'final') => void;

export type Row = { readonly kind: 'draft' | 'final' };

export type Pair = readonly ['left' | 'right', number];

export type Flags<T extends 'a' | 'b' = 'a'> = Record<T, boolean>;

export type Narrow = Extract<'a' | 'b' | 'c', 'a' | 'b'>;

export type Cond<T> = T extends 'a' ? 'no' | 'yes' : 'maybe' | 'never';

export const TONES = ['danger', 'primary'] as const;
export type Tone = (typeof TONES)[number];
export type ToneKey = keyof typeof TONES;
export type Mapped = { readonly [K in Tone]: string };

export interface Descriptor {
  readonly kind: 'draft' | 'final';
}
