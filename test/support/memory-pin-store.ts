/**
 * An in-memory session pin store for Stop hook tests that do not touch the filesystem. It keeps
 * the store contract: create refuses when something is already there, and replace refuses when
 * nothing is. The filesystem checks themselves are held in session-pin-store.test.ts.
 */
import type { SessionPinStore } from '../../src/surfaces/session-pin-store.js';

export interface MemoryPinStore extends SessionPinStore {
  files: Map<string, string>;
  writes: string[];
}

export function memoryPinStore(): MemoryPinStore {
  const files = new Map<string, string>();
  const writes: string[] = [];
  return {
    files,
    writes,
    async read(name) {
      const contents = files.get(name);
      return contents === undefined ? { status: 'missing' } : { status: 'found', contents };
    },
    async create(name, contents) {
      if (files.has(name)) {
        return { status: 'refused', reason: 'a session pin file already exists' };
      }
      files.set(name, contents);
      writes.push(name);
      return { status: 'written' };
    },
    async replace(name, contents) {
      if (!files.has(name)) {
        return { status: 'refused', reason: 'the session pin file disappeared' };
      }
      files.set(name, contents);
      writes.push(name);
      return { status: 'written' };
    },
  };
}
