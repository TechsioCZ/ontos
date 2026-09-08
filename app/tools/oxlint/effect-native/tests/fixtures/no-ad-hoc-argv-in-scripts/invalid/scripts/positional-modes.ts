// expect-count: 4
// scripts/migrate-contacts-authorization.mts style: positional mode plus an alias of the raw array.
const mode = process.argv[2];
const target = process.argv[3] ?? "default";
const [, , command, subcommand] = process.argv;
const everything = process.argv;

export { command, everything, mode, subcommand, target };
