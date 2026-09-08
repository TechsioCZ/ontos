// The import is the coupling even when the call is point-free / aliased through a local.
import { config as loadDotenv } from 'dotenv';

const boot = loadDotenv;

export const run = (): void => {
  boot({ path: '.env' });
};

export const forEachEnv = (paths: readonly string[]): void => {
  paths.map((path) => ({ path })).forEach(loadDotenv);
};
