// expect-count: 7
export const requiredClass = (code: string): boolean => /^(?:08)/u.test(code);
export const repeatedClass = (code: string): boolean => /^(?:08)+/u.test(code);
export const exactClass = (code: string): boolean => /^(?:08){1}/u.test(code);
export const alternatives = (code: string): boolean => /^(?:08|42)/u.test(code);
export const characterClass = (code: string): boolean => /^5[3578]/u.test(code);
export const requiredCharacterClass = (code: string): boolean => /^5[3578]+/u.test(code);
export const runtimeClass = new RegExp('^(?:08|42)', 'u');
