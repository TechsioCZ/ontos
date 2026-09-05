// process.argv.slice(2) written in a comment must not report.
const documented = "process.argv[2]";
const templated = `const forwarded = process.argv.slice(2);`;

export { documented, templated };
