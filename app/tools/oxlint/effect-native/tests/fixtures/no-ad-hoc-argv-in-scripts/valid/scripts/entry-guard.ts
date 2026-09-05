// B3 keeps "one small process-exit adapter at the executable edge": argv[0]/argv[1] are the node
// executable and the entry module path, never user input.
import path from "node:path";
import { pathToFileURL } from "node:url";

const invokedPath = process.argv[1] === undefined ? undefined : path.resolve(process.argv[1]);
const isEntrypoint = invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
const executable = process.argv[0];
const version = process.argv[1]?.match(/([0-9]+)\.([0-9]+)/u);
const [, entryOnly] = process.argv;
const [nodeBinary] = process.argv;

export { entryOnly, executable, isEntrypoint, nodeBinary, version };
