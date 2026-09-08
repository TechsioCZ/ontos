// `DIRECTIVE` has no word boundary after `disable`, so a comment that merely STARTS with the word
// "oxlint-disabled" / "eslint-disabled" is parsed as a file-wide directive whose "rule list" is the
// surrounding prose. ESLint and oxlint both require whitespace or end-of-comment after the directive
// name, and the oxlint binary confirms neither line below suppresses anything.
// oxlint-disabled no-await-in-loop while the generator is rewritten; see the A8 backlog.
// eslint-disabled for the generated file until Codesmith stops emitting it.
export const marker = 1;
