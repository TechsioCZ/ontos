// expect-count: 2
// Evasion surface for `reportCalls`: optional chaining, computed access, casts, nested chains and
// point-free member references. Under the default options only the two imports report.
import * as fs from "node:fs";
import { readFile as read } from "node:fs/promises";

const key = "readFileSync" as const;

export async function inspect(target: string): Promise<string> {
	const direct = fs?.readFileSync?.(target, "utf-8");
	const computed = fs["readFileSync"](target, "utf-8");
	const casted = (fs as unknown as Record<string, (p: string) => string>)[key](target);
	const nested = await fs.promises.readFile(target, "utf-8");
	const aliased = await read(target, "utf-8");
	const pointFree = [target].map(fs.readFileSync);
	return [direct, computed, casted, String(nested), String(aliased), pointFree.join("")].join("");
}
