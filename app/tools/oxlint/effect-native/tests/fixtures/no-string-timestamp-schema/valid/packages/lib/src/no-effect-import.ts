// No `effect` import at all: nothing here is a Schema field bag.
export const row = {
  createdAt: 'STRING',
  updatedAt: 'STRING',
};

export function format(value: { createdAt: Date }): string {
  return value.createdAt.toISOString();
}
