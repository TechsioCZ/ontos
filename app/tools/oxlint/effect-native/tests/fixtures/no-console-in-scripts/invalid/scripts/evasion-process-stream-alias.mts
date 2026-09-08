// B3/A6: aliasing the ambient streams evades `stdioWrite` completely — `const { stdout } = process`
// is the same sink as the `import { stdout } from "node:process"` form the rule already reports.
const { stdout, stderr } = process;
const out = process.stdout;
const { write } = process.stderr;

export function emit(message: string): void {
	stdout.write(`${message}\n`);
	stderr.write(`${message}\n`);
	out.write(`${message}\n`);
	write.call(process.stderr, `${message}\n`);
}
