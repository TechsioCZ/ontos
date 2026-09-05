const codes = new Set(['23505', 'ECONNREFUSED']);
export const known = (code: string): boolean => codes.has(code) || code.startsWith('08');
