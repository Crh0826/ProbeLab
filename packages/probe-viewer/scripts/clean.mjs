import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const target = path.resolve(root, 'dist');
if (path.dirname(target) !== root || path.basename(target) !== 'dist') {
  throw new Error(`Refusing to clean an unexpected viewer build directory: ${target}`);
}
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
