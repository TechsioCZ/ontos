// expect-count: 4
import fsExtra from "fs-extra";
import { ensureDir } from "fs-extra/esm";
import { execaCommand } from "execa";

export { spawnSync } from "node:child_process";

export async function bootstrap(directory: string): Promise<void> {
	await ensureDir(directory);
	await fsExtra.outputFile(`${directory}/role.sql`, "create role runtime;");
	await execaCommand(`psql -f ${directory}/role.sql`);
}
