// `typeof` guards, `in` checks and `instanceof` carry no configuration vocabulary: they say whether
// a value is present, not what it may be. They stay legal alongside a proper Config declaration.
export const configured = () =>
  typeof process.env.DATABASE_URL === 'string' && 'BETTER_AUTH_SECRET' in process.env;

export const keys = () => Object.keys(process.env).length;
