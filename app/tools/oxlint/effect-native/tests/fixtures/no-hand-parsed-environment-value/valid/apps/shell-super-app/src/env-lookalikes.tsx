// False-positive guard: identifiers called `env`/`environment` that are ordinary enum-like objects.
// Only SCREAMING_SNAKE (or computed) member reads count as an environment read.
const env = { mode: 'production', region: 'eu-central-1' } as const;
const Environment = { Production: 'production', Staging: 'staging' } as const;

export const mode = env.mode;
export const isProduction = env.mode === 'production';
export const isStaging = Environment.Staging === 'staging';
export const regionLabel = env.region.toUpperCase();
export const environment = { describe: () => 'shell' };
export const description = environment.describe().trim();
// Static template keys have the same boundary as ordinary string keys.
export function stageLabel(environment: string): string {
  return String(environment[`length`]);
}

export function Badge() {
  const label = env.mode.slice(0, 4);
  return <span data-region={env.region}>{label}</span>;
}
