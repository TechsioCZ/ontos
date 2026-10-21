/**
 * Child-process extractor for the capability catalog. Imports vertical `shared/apis/*.ts` files natively (Node type
 * stripping), so the server process never loads vertical code. Usage:
 *
 *   echo '{"modules":[{"moduleId":"work.tasks","appId":"work-tasks"}]}' \
 *     | node --no-warnings src/catalog/extract-contracts.ts <verticalsRoot>
 *
 * stdout carries exactly one JSON ExtractResponse; every other message goes to stderr.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema } from 'effect';
import { HttpApi } from 'effect/unstable/httpapi';
import { z } from 'zod';

export interface ExtractRequest {
  readonly modules: readonly { readonly moduleId: string; readonly appId: string }[];
}

export interface ExtractedEndpoint {
  readonly path: string;
  readonly schema: Record<string, unknown>;
}

export interface ExtractedModule {
  readonly moduleId: string;
  readonly appId: string;
  readonly endpoints: readonly ExtractedEndpoint[];
}

export interface ExtractResponse {
  readonly modules: readonly ExtractedModule[];
  readonly warnings: readonly string[];
}

const isApiFile = (file: string): boolean =>
  file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.d.ts');

export const extractContracts = async (root: string, request: ExtractRequest): Promise<ExtractResponse> => {
  const warnings: string[] = [];
  const modules: ExtractedModule[] = [];

  for (const { moduleId, appId } of request.modules) {
    const dir = join(root, appId, 'shared', 'apis');
    const endpoints: ExtractedEndpoint[] = [];
    if (!existsSync(dir)) {
      warnings.push(`${appId}: chybí shared/apis`);
      modules.push({ moduleId, appId, endpoints });
      continue;
    }
    const seen = new Set<string>();
    for (const file of readdirSync(dir).sort()) {
      if (!isApiFile(file)) {
        continue;
      }
      let loaded: Record<string, unknown>;
      try {
        loaded = await import(pathToFileURL(join(dir, file)).href);
      } catch (error) {
        warnings.push(`${appId}/${file}: ${String(error).slice(0, 200)}`);
        continue;
      }
      for (const value of Object.values(loaded)) {
        if (!HttpApi.isHttpApi(value)) {
          continue;
        }
        HttpApi.reflect(value, {
          onGroup: () => undefined,
          onEndpoint: ({ endpoint }) => {
            const schema = endpoint.payload.get('application/json')?.schemas[0];
            if (schema === undefined || seen.has(endpoint.path)) {
              return;
            }
            try {
              const document = Schema.toJsonSchemaDocument(schema);
              seen.add(endpoint.path);
              endpoints.push({
                path: endpoint.path,
                schema: Object.assign({}, document.schema, { $defs: document.definitions }) as Record<string, unknown>,
              });
            } catch (error) {
              warnings.push(`${appId}/${file} ${endpoint.path}: ${String(error).slice(0, 200)}`);
            }
          },
        });
      }
    }
    modules.push({ moduleId, appId, endpoints });
  }

  return { modules, warnings };
};

if (process.argv[1]?.endsWith('extract-contracts.ts')) {
  // Vertical modules must not pollute stdout: their logs go to stderr.
  console.log = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };

  const root = process.argv[2];
  if (root === undefined) {
    process.stderr.write('Použití: extract-contracts.ts <verticalsRoot>\n');
    process.exit(2);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const request = z
    .object({ modules: z.array(z.object({ moduleId: z.string(), appId: z.string() })) })
    .parse(JSON.parse(Buffer.concat(chunks).toString('utf-8')));

  process.stdout.write(JSON.stringify(await extractContracts(root, request)));
}
