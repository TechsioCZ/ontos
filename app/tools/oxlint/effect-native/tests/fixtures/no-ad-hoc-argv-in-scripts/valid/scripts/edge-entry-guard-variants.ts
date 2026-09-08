// Every spelling of the blessed argv[0]/argv[1] entry guard.
const executable = process.argv[0];
const entry = process.argv[1];
const entryString = process.argv["1"];
const hexEntry = process.argv[0x1];
const [, onlyEntry] = process.argv;
const [nodeBinary] = process.argv;
const [, ,] = process.argv;
const suffix = process.argv[1]?.endsWith(".mts");

export { entry, entryString, executable, hexEntry, nodeBinary, onlyEntry, suffix };
