// expect-count: 4
// A3: an operational script reaching the environment through the `node:process` module.
import nodeProcess from "node:process";
import { env } from "process";

export const home = nodeProcess.env.HOME;

const { env: ambient } = nodeProcess;

export const searchPath = nodeProcess["env"]["PATH"];

export const port = env.PORT;

export const databaseUrl = ambient.DATABASE_URL;
