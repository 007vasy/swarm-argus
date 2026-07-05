// "Jump in" support for observer mode: produce the command to resume a session
// and, best-effort on Linux, focus the terminal window that owns it.
// We never inject input into a running session — resume is read/attach only.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { ResumeResult } from '../shared/types.js';

const pexec = promisify(exec);

async function has(cmd: string): Promise<boolean> {
  try {
    await pexec(`command -v ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort focus: if wmctrl is available, try to raise a terminal window
 * whose title mentions the session id (many terminals show the running command
 * or cwd in the title). This is intentionally forgiving — failure is fine.
 */
async function tryFocus(sessionId: string): Promise<boolean> {
  if (!(await has('wmctrl'))) return false;
  try {
    const { stdout } = await pexec('wmctrl -l');
    const short = sessionId.slice(0, 8);
    const match = stdout
      .split('\n')
      .find((l) => l.includes(sessionId) || l.includes(short));
    if (!match) return false;
    const winId = match.split(/\s+/)[0];
    await pexec(`wmctrl -i -a ${winId}`);
    return true;
  } catch {
    return false;
  }
}

export async function resumeSession(sessionId: string, cwd?: string): Promise<ResumeResult> {
  const command = `claude --resume ${sessionId}`;
  const focused = await tryFocus(sessionId);
  return {
    sessionId,
    command,
    focused,
    note: focused
      ? 'Focused a matching terminal window.'
      : `Run this in ${cwd ?? 'the project directory'} to attach.`,
  };
}
