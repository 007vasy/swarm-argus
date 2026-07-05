#!/usr/bin/env node
// Installs Swarm Argus hooks into ~/.claude/settings.json for lower-latency,
// real-time swarm updates. Purely additive: existing hooks are preserved, and
// re-running is idempotent. Uninstall with `npm run uninstall-hooks`.
//
// Each installed hook posts the event payload (delivered on stdin by Claude
// Code) to the running backend. The trailing `# swarm-argus` marker lets the
// uninstaller find and remove exactly these entries.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = process.env.PORT ?? '4000';
const MARKER = '# swarm-argus';
const ENDPOINT = `http://localhost:${PORT}/api/hook`;
const COMMAND = `curl -s -X POST ${ENDPOINT} -H 'content-type: application/json' -d @- >/dev/null 2>&1 ${MARKER}`;

// Events we care about. Tool events use an all-matching matcher; lifecycle
// events omit the matcher (fire on every occurrence).
const EVENTS = {
  PostToolUse: { matcher: '*' },
  SubagentStop: {},
  Notification: {},
  Stop: {},
  SessionStart: {},
  SessionEnd: {},
};

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');

function hasMarker(group) {
  return Array.isArray(group?.hooks) && group.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(MARKER));
}

const raw = await fs.readFile(settingsPath, 'utf8').catch(() => '{}');
let settings;
try {
  settings = JSON.parse(raw);
} catch (err) {
  console.error(`Could not parse ${settingsPath}: ${err.message}`);
  process.exit(1);
}

// Back up once before mutating.
const backup = `${settingsPath}.bak-swarm-argus`;
await fs.writeFile(backup, raw);

settings.hooks ??= {};
let added = 0;
for (const [event, cfg] of Object.entries(EVENTS)) {
  settings.hooks[event] ??= [];
  const arr = settings.hooks[event];
  if (arr.some(hasMarker)) continue; // already installed for this event
  const group = { ...(cfg.matcher ? { matcher: cfg.matcher } : {}), hooks: [{ type: 'command', command: COMMAND }] };
  arr.push(group);
  added++;
}

await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n');

console.log(added > 0
  ? `✓ Installed Swarm Argus hooks for ${added} event(s) → ${ENDPOINT}`
  : '✓ Swarm Argus hooks already present — nothing to do.');
console.log(`  Backup written to ${backup}`);
console.log('  Start (or restart) any Claude Code session for hooks to take effect.');
console.log('  Remove with:  npm run uninstall-hooks');
