// expect-count: 1
// A lookalike runPromise method cannot claim the Effect executable-adapter exemption.
const facade = {runPromise: () => Promise.resolve(0)};
facade.runPromise().then(() => { process.exitCode = 1; });
