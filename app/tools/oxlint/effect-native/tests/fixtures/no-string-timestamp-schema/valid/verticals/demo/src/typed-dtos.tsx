import type { DateTime } from 'effect';

// Temporal DTO members that already carry a real temporal type.
interface CustomerRow {
  readonly createdAt: Date;
  readonly updatedAt: DateTime.Utc;
  readonly archivedAt: Date | null;
  readonly name: string;
  readonly format: string;
}

// A type derived from a Schema, not re-declared.
type SessionProps = {
  readonly lastSeenAt: DateTime.Utc;
  readonly label: string;
};

// Method signatures and index signatures are not property members.
interface Clock {
  nowAt(): Date;
  readonly [key: string]: unknown;
}

export function render(row: CustomerRow, props: SessionProps, clock: Clock): string {
  return `${row.name}${props.label}${String(clock.nowAt())}`;
}
