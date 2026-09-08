// expect-count: 4
const fromGlobal = globalThis.process.argv.slice(2);
const fromBun = Bun.argv[2];
const optional = process?.argv?.[4];
const computedHost = globalThis["process"].argv.at(-1);

export { computedHost, fromBun, fromGlobal, optional };
