// expect-count: 3
import { Effect } from "effect";
import { writeFile } from "node:fs/promises";

// A8: the scaffolds are themselves async programs, so they emit async programs.
export const writeTemplate = async (path: string, contents: string): Promise<void> => {
	await writeFile(path, contents, "utf8");
};

const templates = ["page.tsx", "route.ts"];

await Promise.all(templates.map(async (template) => writeTemplate(template, "// generated\n")));

void Effect.void;
