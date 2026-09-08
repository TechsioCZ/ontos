// expect-count: 5
// Audit A3/A8 evidence shape: apps/shell-super-app/modern.config.ts:117 — a build-time environment
// reader helper, again invisible to an ambient `process.env` rule.
declare function getBuildConfigEnvironment(name: string): string | undefined;

const envValue = (name: string) => getBuildConfigEnvironment(name)?.trim();

export const port = Number(getBuildConfigEnvironment('SHELL_SUPER_APP_PORT') ?? 3020);
export const cloudflareDeploy = getBuildConfigEnvironment('MODERNJS_DEPLOY') === 'cloudflare';
export const zephyrCiDeploy = (getBuildConfigEnvironment('ZE_CI_TOKEN') ?? '').length > 0;

const devOrigin = envValue('ULTRAMODERN_MF_DEV_ORIGIN') || 'http://localhost:3020';
export const secureOrigin = devOrigin.startsWith('https://');
