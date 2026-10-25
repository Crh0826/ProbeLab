import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import type { ProbeCliIO } from './types.js';

export function createNodeIO(): ProbeCliIO {
  return {
    stdout(text): void {
      process.stdout.write(text);
    },
    stderr(text): void {
      process.stderr.write(text);
    },
    async readFile(path, maxBytes): Promise<Uint8Array> {
      if (maxBytes !== undefined) {
        const info = await stat(path);
        if (info.size > maxBytes) throw new Error(`Input exceeds the ${maxBytes}-byte size limit.`);
      }
      return new Uint8Array(await readFile(path));
    },
    async writeFile(path, data): Promise<void> {
      await writeFile(path, data, 'utf8');
    },
    async mkdir(path): Promise<void> {
      await mkdir(path, { recursive: true });
    },
    cwd(): string {
      return process.cwd();
    },
    async yield(): Promise<void> {
      await yieldImmediate();
    },
    now(): number {
      return Date.now();
    },
    onInterrupt(handler): () => void {
      process.on('SIGINT', handler);
      return () => process.off('SIGINT', handler);
    }
  };
}
