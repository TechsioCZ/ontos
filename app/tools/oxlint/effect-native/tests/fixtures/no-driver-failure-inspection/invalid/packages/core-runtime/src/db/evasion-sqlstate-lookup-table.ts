// EVASION: `isExpressionContext` returns false for an object-literal *key*, so a SQLSTATE -> reason
// lookup table - the ad hoc taxonomy audit A5 targets - is entirely silent. Fix: allow a Property
// key when the literal matches `sqlStatePattern`.
const SQLSTATE_TO_REASON: Record<string, string> = {
	'23505': 'unique_violation',
	'40001': 'serialization_failure',
	'57P01': 'admin_shutdown',
};
export const reasonFor = (code: string): string | undefined => SQLSTATE_TO_REASON[code];
