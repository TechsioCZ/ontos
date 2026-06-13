import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const sql = fs.readFileSync(path.join(root, 'scripts/seed.sql'), 'utf-8');
const database = process.env['POSTGRES_DB'] ?? 'ontos_mvp';
const user = process.env['POSTGRES_USER'] ?? 'ontos';

const result = spawnSync(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    user,
    '-d',
    database,
    '-v',
    'ON_ERROR_STOP=1',
  ],
  {
    cwd: root,
    input: sql,
    stdio: ['pipe', 'inherit', 'inherit'],
  },
);

process.exit(result.status ?? 1);
