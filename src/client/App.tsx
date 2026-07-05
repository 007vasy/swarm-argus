import React, { useEffect } from 'react';
import { connectWs } from './socket.js';
import { useStore } from './store.js';
import { SwarmGraph } from './components/SwarmGraph.js';
import { DetailPanel } from './components/DetailPanel.js';
import { StatusBar } from './components/StatusBar.js';
import { Timeline } from './components/Timeline.js';

export function App() {
  const mode = useStore((s) => s.mode);
  useEffect(() => {
    connectWs();
  }, []);

  return (
    <div className={`app ${mode}`}>
      <StatusBar />
      <div className="stage">
        <SwarmGraph />
        <DetailPanel />
      </div>
      {mode === 'replay' && <Timeline />}
    </div>
  );
}
