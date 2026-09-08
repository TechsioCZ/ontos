// expect-count: 1
const loop = async (): Promise<void> => { await loop(); };
void loop;
