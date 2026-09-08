const KEY = 'createdAt';

// Signatures that are not string-typed property signatures.
interface Clock {
  createdAt(): string;
  readonly updatedAt: () => string;
  readonly expiresAt: string | number;
  readonly archivedAt: Date | null;
  readonly [key: string]: unknown;
  readonly [KEY]: string;
}

declare module 'external-rows' {
  interface Row {
    readonly createdAt: Date;
  }
}

export function Panel(clock: Clock) {
  return <time dateTime={String(clock.createdAt())}>{String(clock.expiresAt)}</time>;
}
