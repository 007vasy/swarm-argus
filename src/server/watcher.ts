// Watches ~/.claude/projects/**/*.jsonl and emits parsed transcript lines.
// Tracks a byte offset per file so appends are tailed incrementally, and reads
// the full backlog once on startup so replay/history works with zero config.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';

export interface WatcherOptions {
  /** Root to watch. Defaults to ~/.claude/projects */
  root?: string;
}

export declare interface TranscriptWatcher {
  on(event: 'line', l: (line: any, file: string) => void): this;
  on(event: 'ready', l: () => void): this;
  on(event: 'error', l: (err: Error) => void): this;
}

export class TranscriptWatcher extends EventEmitter {
  private root: string;
  private offsets = new Map<string, number>();
  private queue = new Map<string, Promise<void>>();
  private watcher?: FSWatcher;

  constructor(opts: WatcherOptions = {}) {
    super();
    this.root = opts.root ?? path.join(os.homedir(), '.claude', 'projects');
  }

  get watchRoot() {
    return this.root;
  }

  async start(): Promise<void> {
    this.watcher = chokidar.watch('**/*.jsonl', {
      cwd: this.root,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
    });
    this.watcher
      .on('add', (rel) => this.enqueue(path.join(this.root, rel)))
      .on('change', (rel) => this.enqueue(path.join(this.root, rel)))
      .on('error', (err) => this.emit('error', err as Error))
      .on('ready', () => this.emit('ready'));
  }

  async stop(): Promise<void> {
    await this.watcher?.close();
  }

  /** Serialize reads per file so overlapping change events don't double-read. */
  private enqueue(file: string): void {
    const prev = this.queue.get(file) ?? Promise.resolve();
    const next = prev
      .then(() => this.readNew(file))
      .catch((err) => {
        this.emit('error', err);
      });
    this.queue.set(file, next);
  }

  private async readNew(file: string): Promise<void> {
    let size: number;
    try {
      size = (await fs.stat(file)).size;
    } catch {
      this.offsets.delete(file);
      return;
    }
    const from = this.offsets.get(file) ?? 0;
    if (size < from) {
      // File was truncated/rotated — start over.
      this.offsets.set(file, 0);
      return this.readNew(file);
    }
    if (size === from) return;

    // Read the new bytes, but only consume up to the last complete line so a
    // half-written final line is re-read (not lost) on the next change event.
    const handle = await fs.open(file, 'r');
    try {
      const length = size - from;
      const buf = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buf, 0, length, from);
      const lastNl = buf.lastIndexOf(0x0a); // '\n'
      if (lastNl === -1) return; // no complete line yet; keep offset, wait for more
      const complete = buf.subarray(0, lastNl).toString('utf8');
      for (const raw of complete.split('\n')) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        try {
          this.emit('line', JSON.parse(trimmed), file);
        } catch {
          /* skip partial/corrupt line — tolerant by design */
        }
      }
      this.offsets.set(file, from + lastNl + 1);
      void bytesRead;
    } finally {
      await handle.close();
    }
  }
}
