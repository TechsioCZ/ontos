// False-positive probe: a local binding named `exit` shadowing the `node:process` import.
import { exit } from "node:process";

export const run = (): void => {
	const exit = (code: number): string => `local ${code}`;
	console.log(exit(0));
};

if (process.argv[1] !== undefined) {
	exit(0);
}
