import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
await mkdir(path.join(root, 'dist'), { recursive: true });
await copyFile(path.join(root, 'src/style.css'), path.join(root, 'dist/style.css'));
