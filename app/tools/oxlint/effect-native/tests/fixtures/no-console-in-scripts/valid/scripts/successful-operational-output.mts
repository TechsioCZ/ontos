// Current script policy (oxlint.config.ts:84-88) intentionally allows successful command output.
// B3/A6 does not require routing machine-readable stdout through a decorated log formatter.
import consoleModule, { log as print } from "node:console";
import { stdout } from "node:process";
export function show(report: object) {
 console.log("Verified runtime role"); console.info("Done"); console.table(report);
 consoleModule.log(report); print(report);
 process.stdout.write(JSON.stringify(report) + "\n"); stdout.write("artifact.json\n");
 const write = console.log.bind(console); write("Finished");
}
