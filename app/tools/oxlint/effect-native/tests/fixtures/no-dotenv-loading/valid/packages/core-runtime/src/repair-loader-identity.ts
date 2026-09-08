// Merely obtaining another node:module member does not create a module loader.
const { isBuiltin } = require('node:module');
export const supported = isBuiltin('dotenv');

export function localModule(require: (name: string) => { createRequire: () => (name: string) => unknown }) {
  const loader = require('node:module').createRequire();
  return loader('dotenv');
}

// A block-local name must resolve to its own definition, not another scope's tracked alias.
export function localFactory(createRequire: () => (name: string) => unknown) {
  const loader = createRequire();
  return loader('dotenv');
}
