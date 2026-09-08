// expect-count: 5
import 'dotenv/config';
import * as dotenv from 'dotenv';

export const parsed = dotenv['parse']('A=1');
export const reloaded = dotenv?.config({ quiet: true });

export const lazy = async (): Promise<unknown> => await import('dotenv-flow');
