import React, { useEffect, useRef } from 'react';
import { useStore } from '../store.js';

// Bottom replay scrubber. Only rendered in replay mode. Drives the store's
// replay.t; the graph re-derives visible nodes at that instant.
export function Timeline() {
  const replay = useStore((s) => s.replay);
  const setReplayTime = useStore((s) => s.setReplayTime);
  const setPlaying = useStore((s) => s.setReplayPlaying);
  const setSpeed = useStore((s) => s.setReplaySpeed);
  const raf = useRef<number | null>(null);
  const last = useRef<number>(0);

  // Playback loop: advance replay.t by (speed × real elapsed) each frame.
  useEffect(() => {
    if (!replay?.playing) {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
      return;
    }
    const step = (now: number) => {
      const st = useStore.getState().replay;
      if (!st) return;
      const dt = last.current ? now - last.current : 16;
      last.current = now;
      let t = st.t + dt * st.speed;
      if (t >= st.tMax) {
        t = st.tMax;
        setPlaying(false);
      }
      setReplayTime(t);
      raf.current = requestAnimationFrame(step);
    };
    last.current = 0;
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [replay?.playing, setReplayTime, setPlaying]);

  if (!replay) return null;
  const span = Math.max(1, replay.tMax - replay.tMin);
  const pct = ((replay.t - replay.tMin) / span) * 100;
  const atEnd = replay.t >= replay.tMax;

  return (
    <footer className="timeline">
      <button
        className="btn small"
        onClick={() => {
          if (atEnd) setReplayTime(replay.tMin); // restart if parked at the end
          setPlaying(!replay.playing);
        }}
      >
        {replay.playing ? '❚❚' : '▶'}
      </button>
      <button className="btn small" onClick={() => setReplayTime(replay.tMin)}>
        ⏮
      </button>
      <div className="track">
        <input
          type="range"
          min={replay.tMin}
          max={replay.tMax}
          value={replay.t}
          step={span / 1000}
          onChange={(e) => {
            setPlaying(false);
            setReplayTime(Number(e.target.value));
          }}
        />
        <div className="track-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="tl-time">{new Date(replay.t).toLocaleString()}</div>
      <label className="speed">
        ×
        <select value={replay.speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {[1, 4, 8, 20, 60, 200].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
    </footer>
  );
}
