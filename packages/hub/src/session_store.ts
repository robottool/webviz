/**
 * Layout persistence (§5 REST API). Stores workspace layouts as JSON files in a
 * data directory so they survive restarts. The webapp also keeps a copy in
 * localStorage; the hub is the shared/multi-user source of truth.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export class SessionStore {
  constructor(private dir: string) {}

  private async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private fileFor(name: string) {
    // Constrain to a flat namespace of safe filenames.
    const safe = name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  async list(): Promise<string[]> {
    await this.ensureDir();
    const files = await fs.readdir(this.dir);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));
  }

  async get(name: string): Promise<unknown | null> {
    try {
      const txt = await fs.readFile(this.fileFor(name), 'utf8');
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }

  async save(name: string, layout: unknown): Promise<void> {
    await this.ensureDir();
    await fs.writeFile(this.fileFor(name), JSON.stringify(layout, null, 2));
  }

  async delete(name: string): Promise<boolean> {
    try {
      await fs.unlink(this.fileFor(name));
      return true;
    } catch {
      return false;
    }
  }
}
