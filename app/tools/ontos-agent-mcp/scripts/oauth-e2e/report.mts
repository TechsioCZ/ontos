import { mkdir, writeFile } from 'node:fs/promises';

export interface StepResult {
  readonly variant: string;
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
  readonly ms: number;
}

export class Recorder {
  readonly steps: StepResult[] = [];
  readonly lines: string[] = [];

  log(line: string): void {
    this.lines.push(line);
    process.stdout.write(line + '\n');
  }

  /** Runs one check; errors become a failed step and the function returns undefined. */
  async step<A>(
    variant: string,
    name: string,
    body: () => Promise<{ pass: boolean; detail: string; value?: A }>,
  ): Promise<A | undefined> {
    const started = Date.now();
    let pass = false;
    let detail = '';
    let value: A | undefined = undefined;
    try {
      const outcome = await body();
      pass = outcome.pass;
      detail = outcome.detail;
      value = outcome.value;
    } catch (error) {
      pass = false;
      detail = error instanceof Error ? error.message : String(error);
      value = undefined;
    }
    const ms = Date.now() - started;
    this.steps.push({ variant, name, pass, detail, ms });
    this.log(`${pass ? 'PASS' : 'FAIL'} [${variant}] ${name} — ${detail} (${ms} ms)`);
    return value;
  }

  get pass(): boolean {
    return this.steps.length > 0 && this.steps.every((step) => step.pass);
  }

  async write(outDir: string, baseName: string, meta: Record<string, unknown>): Promise<void> {
    await mkdir(outDir, { recursive: true });
    const report = { ...meta, finishedAt: new Date().toISOString(), pass: this.pass, steps: this.steps };
    await writeFile(`${outDir}/${baseName}.json`, JSON.stringify(report, null, 2));
    await writeFile(`${outDir}/${baseName}.log`, this.lines.join('\n') + '\n');
  }
}
