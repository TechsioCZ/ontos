import { spawnSync } from 'node:child_process';

const result = spawnSync('lefthook', ['install'], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(`Unable to install lefthook hooks: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
