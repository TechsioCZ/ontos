/** pg_get_constraintdef returns SQL text. Match literal fragments (including SQL and regex punctuation), not tokens. */
export const matchesHistoryConstraint = (
  definition: string,
  exact?: string,
  fragments: readonly string[] = [],
): boolean => {
  const hasFragment = (fragment: string) => definition.includes(fragment);
  return (exact === undefined || definition === exact) && fragments.every(hasFragment);
};
