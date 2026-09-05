// expect-count: 2
type SqlState = string;
export const unique = ('23505' as SqlState) === ('23505' satisfies SqlState);
