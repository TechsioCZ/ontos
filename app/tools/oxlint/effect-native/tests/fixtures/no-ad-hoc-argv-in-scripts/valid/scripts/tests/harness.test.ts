// Test files belong to B2's harness migration, not B3's argv finding.
const forwardedArgs = process.argv.slice(2);
const mode = process.argv[2];

export { forwardedArgs, mode };
