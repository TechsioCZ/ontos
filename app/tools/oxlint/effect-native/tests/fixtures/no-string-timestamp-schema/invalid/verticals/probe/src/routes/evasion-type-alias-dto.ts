// expect-count: 2
// Evasion: the DTO members are still plain strings, hidden behind an in-file alias.
type IsoTimestamp = string;
type CalendarDate = string | null;

export interface CustomerRow {
  readonly customerId: string;
  // 1 createdAt
  readonly createdAt: IsoTimestamp;
  // 2 dissolvedOn
  readonly dissolvedOn: CalendarDate;
  readonly name: string;
}
