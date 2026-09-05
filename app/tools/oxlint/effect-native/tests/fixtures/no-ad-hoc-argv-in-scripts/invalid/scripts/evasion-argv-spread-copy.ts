// Evasion: copy argv with a spread first — the copy is an ArrayExpression, so the declarator is
// no longer "initialised with argv" and the destructuring never reports.
const copy = [...process.argv];
const [, , command, subcommand] = copy;

export { command, subcommand };
