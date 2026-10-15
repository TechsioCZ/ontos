// expect-count: 2
const securePrefix = '__Secure-';

export const inspectAndConstruct = (name: string) => ({
  matches: name.startsWith(securePrefix),
  constructed: `${securePrefix}${name}`,
});

export const escapedPrefix = '__Host-';
