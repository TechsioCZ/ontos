// expect-count: 5
import type { ReactNode } from 'react';

// 1 createdAt, 2 updatedAt, 3 archivedAt (string | null)
interface CustomerRow {
  readonly customerId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly name: string;
  readonly establishedOn: Date;
}

// 4 lastSeenAt inside an inline type literal, 5 expiresAt optional string | undefined
type SessionProps = {
  readonly lastSeenAt: string;
  readonly expiresAt?: string | undefined;
  readonly children: ReactNode;
};

export function render(row: CustomerRow, props: SessionProps): string {
  return `${row.name}${String(props.expiresAt)}`;
}
