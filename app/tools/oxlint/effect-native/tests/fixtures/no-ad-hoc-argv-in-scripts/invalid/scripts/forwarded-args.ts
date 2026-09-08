// expect-count: 4
// The `const forwardedArgs = process.argv.slice(2)` wrapper preamble repeated across ~14 scripts.
const forwardedArgs = process.argv.slice(2);
const hasFix = process.argv.includes("--fix");
const arity = process.argv.length;
const joined = (process.argv as readonly string[]).join(" ");

export { arity, forwardedArgs, hasFix, joined };
