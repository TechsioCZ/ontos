// Evasion: alias argv through a plain identifier assignment (not a declarator), then index it.
let bucket: readonly string[] = [];
bucket = process.argv;
const mode = bucket[2];

export { mode };
