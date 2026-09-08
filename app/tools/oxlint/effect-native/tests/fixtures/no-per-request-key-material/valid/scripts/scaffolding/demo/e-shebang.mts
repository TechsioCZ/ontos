#!/usr/bin/env node
export const render = (name: string): string => `
export const NAME = '${name}';
export const nested = \`inner ${'${name}'} \`;
`;
