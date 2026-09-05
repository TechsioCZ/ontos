// A8: scaffolds emit console text; a string literal is not a call site.
export const template = `
console.log("generated");
process.stderr.write("generated\\n");
`;
