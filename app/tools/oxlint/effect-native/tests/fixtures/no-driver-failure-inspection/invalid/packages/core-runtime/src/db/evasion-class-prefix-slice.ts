// EVASION: `code.slice(0, 2) === '08'` is the same SQLSTATE class prefix test as
// `code.startsWith('08')`, but axis 6 only matches `prefixMethods`. Fix: also match an equality
// comparison whose other operand is a `.slice(0, 2)` / `.substring(0, 2)` / `.substr(0, 2)` call.
export const connectivity = (code: string): boolean =>
	code.slice(0, 2) === '08' || code.substring(0, 2) === '57';
