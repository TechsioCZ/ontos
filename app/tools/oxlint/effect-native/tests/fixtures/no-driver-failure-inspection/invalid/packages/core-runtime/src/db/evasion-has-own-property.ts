// EVASION: `Object.hasOwn` / `Reflect.has` / `hasOwnProperty.call` are the lint-clean modern
// replacements for `'key' in obj` (see eslint `no-prototype-builtins`), and none is a
// BinaryExpression, so axis 1 sees nothing. Fix: also match these three call shapes.
export const isDriverFailure = (error: object): boolean =>
	Object.hasOwn(error, 'code') &&
	Reflect.has(error, 'cause') &&
	Object.prototype.hasOwnProperty.call(error, 'constraint');
