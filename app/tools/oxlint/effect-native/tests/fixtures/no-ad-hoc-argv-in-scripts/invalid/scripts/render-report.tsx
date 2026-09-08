// expect-count: 2
const format = process.argv[2];
const flags = process.argv.slice(3);

export const Report = () => <section data-format={format}>{flags.join(" ")}</section>;
