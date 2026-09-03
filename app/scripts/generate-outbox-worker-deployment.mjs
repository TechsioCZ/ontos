import fs from 'node:fs';
import path from 'node:path';
import { outboxWorkerDelivery } from './outbox-worker-delivery.mjs';

export const generateOutboxWorkerDeployment = (root, source) => {
  const topology = JSON.parse(
    fs.readFileSync(path.join(root, 'topology/reference-topology.json'), 'utf-8'),
  );
  let result = source.replace(
    /\n {2}# <generated-outbox-worker-deployments>[\s\S]*? {2}# <\/generated-outbox-worker-deployments>\n?/u,
    '\n',
  );
  const services = [];
  for (const vertical of topology.verticals) {
    const delivery = outboxWorkerDelivery(root, vertical);
    if (!delivery) {
      continue;
    }
    const ownerSection = result
      .split(/(?=^ {2}- setup:)/mu)
      .find((section) => section.startsWith(`  - setup: '${vertical.id}'\n`));
    if (!ownerSection) {
      throw new Error(`Missing owner deployment for ${vertical.id}`);
    }
    const port = ownerSection.match(/^ {8}PORT: '(?<port>[0-9]+)'$/mu)?.groups?.port;
    if (!port || port !== new URL(vertical.moduleFederation.manifestUrl).port) {
      throw new Error(`Owner port disagrees with topology for ${vertical.id}`);
    }
    const service = ownerSection
      .trimEnd()
      .replace(`setup: '${vertical.id}'`, `setup: '${delivery.id}'`)
      .replaceAll(`runtime/${vertical.id}`, `runtime/${delivery.id}`)
      .split('\n')
      .filter(
        (line) =>
          !line.includes(' run build') &&
          !line.includes("- cp 'app/topology/") &&
          !line.includes('VERTICAL_'),
      )
      .map((line) =>
        line.includes('run zerops:materialize')
          ? line.replace(
              'cd app && ',
              'cd app && ULTRAMODERN_SOURCE_REVISION="$(git rev-parse HEAD)" ',
            )
          : line,
      )
      .join('\n')
      .replace(/(?<command>run zerops:materialize[^\n]*)/u, '$<command> --worker')
      .replaceAll(`/${vertical.id}-api/${vertical.id}/readiness`, '/ready')
      .replace(
        `ULTRAMODERN_ZEROPS_SERVICE: ${vertical.id}`,
        `ULTRAMODERN_ZEROPS_SERVICE: ${delivery.id}`,
      )
      .replace(
        `        PORT: '${port}'`,
        `        PORT: '${port}'\n        OUTBOX_WORKER_HEALTH_PORT: '${port}'\n        DATABASE_URL: \${${vertical.id}_DATABASE_URL}`,
      );
    services.push(service);
  }
  if (services.length === 0) {
    return result;
  }
  result = `${result.trimEnd()}\n\n  # <generated-outbox-worker-deployments>\n${services.join('\n\n')}\n  # </generated-outbox-worker-deployments>\n`;
  return result;
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const root = process.cwd();
  const file = path.join(root, 'zerops.yaml');
  const source = fs.readFileSync(file, 'utf-8');
  const generated = generateOutboxWorkerDeployment(root, source);
  if (process.argv.includes('--write')) {
    fs.writeFileSync(file, generated);
  } else if (source !== generated) {
    throw new Error(
      'Worker deployment drift: run node scripts/generate-outbox-worker-deployment.mjs --write',
    );
  }
}
