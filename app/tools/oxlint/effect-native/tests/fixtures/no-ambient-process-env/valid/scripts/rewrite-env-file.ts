// D tier: line-preserving `.env` file rewriting where comments and ordering must survive. This
// reads and writes a *file*, never the ambient environment of the current process.
import { readFileSync, writeFileSync } from "node:fs";

export function setEnvValue(file: string, key: string, value: string): void {
	const lines = readFileSync(file, "utf8").split("\n");
	const index = lines.findIndex((line) => line.startsWith(`${key}=`));
	if (index === -1) lines.push(`${key}=${value}`);
	else lines[index] = `${key}=${value}`;
	writeFileSync(file, lines.join("\n"));
}

const env: Record<string, string> = {};
env.DATABASE_URL = "postgres://localhost/ontos";
delete env.DATABASE_URL;

export const collected = env;
