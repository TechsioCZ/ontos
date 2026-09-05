#!/usr/bin/env node
// Shebang parse probe + dotenv subpath entrypoints that are still the same package.
import 'dotenv/config.js';
import 'dotenv-flow/config';
import { config as loadEnvX } from '@dotenvx/dotenvx';

loadEnvX({ path: '.env' });
