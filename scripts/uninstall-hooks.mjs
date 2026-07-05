#!/usr/bin/env node
// Removes Swarm Argus hooks from ~/.claude/settings.json, leaving every other
// hook untouched. Identifies its own entries by the `# swarm-argus` marker.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '# swarm-argus';
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

function hasMarker(group) {
  return Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(MARKER));
}

const raw = await fs.readFile(settingsPath, 'utf8').catch(() => null);
if (raw == null) {
  console.log('No settings.json found — nothing to remove.');
  process.exit(0);
}
let settings;
try {
  settings = JSON.parse(raw);
} catch (err) {
  console.error(`Could not parse ${settingsPath}: ${err.message}`);
  process.exit(1);
}

let removed = 0;
if (settings.hooks) {
  for (const event of Object.keys(settings.hooks)) {
    const before = settings.hooks[event]?.length ?? 0;
    settings.hooks[event] = (settings.hooks[event] ?? []).filter((g) => !hasMarker(g));
    removed += before - settings.hooks[event].length;
    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(removed > 0
  ? `✓ Removed ${removed} Swarm Argus hook entr${removed === 1 ? 'y' : 'ies'}.`
  : '✓ No Swarm Argus hooks were present.');
