import { execFileSync } from 'node:child_process';

export const utilitySource = `
// JSON.parse(rawConfig); process.env.ONTOS_CONFIG; dotenv.config();
const docs = "process.env.ONTOS_CONFIG and JSON.parse(rawConfig)";
const dotenvGuide = 'dotenv';
export const requestUrl = (request) => new URL(request.url);
export const assetUrl = new URL('./worker.ts', import.meta.url);
export const normalize = (value) => Array.isArray(value) ? value.map(normalize) : typeof value === 'object' ? value : null;
`;
console.log(`process.env.ONTOS_CONFIG JSON.parse(config)`);
execFileSync('sh', ['-c', `process.env.ONTOS_CONFIG`]);
