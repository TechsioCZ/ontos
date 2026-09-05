// expect-count: 1
// generators/ scope: per-module dotenv reports; relative URL resolution is not config validation.
export const renderBootstrap = (): string => `
import 'dotenv/config';
export const endpoint = new URL('/gateway', base);
`;
