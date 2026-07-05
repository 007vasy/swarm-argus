import type { ServerMessage } from '../shared/types.js';
import { useStore } from './store.js';

// WebSocket client with exponential-backoff reconnect. The server pushes a full
// snapshot on connect, then incremental deltas.
export function connectWs(): void {
  let backoff = 500;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  function open() {
    const ws = new WebSocket(url);
    ws.onopen = () => {
      backoff = 500;
      useStore.getState().setConnected(true);
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as ServerMessage;
        useStore.getState().applyMessage(msg);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onclose = () => {
      useStore.getState().setConnected(false);
      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };
    ws.onerror = () => ws.close();
  }

  open();
}
