// Numeric, implicit and mixed enums are not closed *string* vocabularies: their runtime values are
// not the vocabulary, so `Schema.Literals` is not the mechanical replacement and they must not report.
export enum Direction {
  Up,
  Down,
}

export enum HttpPort {
  Http = 80,
  Https = 443,
}

export enum Mixed {
  Named = 'named',
  Ordinal = 1,
}

// Ambient enums describe code someone else owns.
declare const enum AmbientKind {
  A = 'a',
  B = 'b',
}

declare global {
  const enum GlobalKind {
    A = 'a',
    B = 'b',
  }
}

export const port: HttpPort = HttpPort.Https;
export const kind: AmbientKind = AmbientKind.A;
