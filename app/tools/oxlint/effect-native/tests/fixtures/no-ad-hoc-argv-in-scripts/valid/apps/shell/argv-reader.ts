// Outside scripts/**: B3 is about operational scripts.
const forwardedArgs = process.argv.slice(2);
const mode = process.argv[2];

export { forwardedArgs, mode };
