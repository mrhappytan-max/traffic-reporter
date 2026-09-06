import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function readLocalState(path) {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.events !== 'object') {
      throw new Error('unsupported or malformed state schema');
    }
    return parsed;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Cannot read local PBS state: ${error.message}`);
  }
}

export async function writeLocalState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}
