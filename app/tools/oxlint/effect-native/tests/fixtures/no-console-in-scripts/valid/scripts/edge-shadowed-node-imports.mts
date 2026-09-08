// A parameter that shadows a `node:console` / `node:process` named import is an injected sink, not
// the ambient one: the rule documents that the scope graph is walked before reporting.
import { error } from "node:console";
import { stdout } from "node:process";

void error;
void stdout;

export function report(error: (message: string) => void): void {
	error("injected sink, not node:console");
}

export function pipe(stdout: { readonly write: (chunk: string) => void }): void {
	stdout.write("injected stream\n");
}
