import type { ReactNode } from "react";

export function Panel({ title, sub, action, children, grow, style }: { title: string; sub?: string; action?: ReactNode; children: ReactNode; grow?: boolean; style?: React.CSSProperties }) {
  return (
    <section className={"panel" + (grow ? " grow" : "")} style={style}>
      <header className="panel-h">
        <span>{title}{sub && <span className="sub">{sub}</span>}</span>
        {action}
      </header>
      <div className="panel-b">{children}</div>
    </section>
  );
}

export function StatRow({ label, value, color, delta, deltaColor, big }: { label: string; value: ReactNode; color?: string; delta?: string; deltaColor?: string; big?: boolean }) {
  return (
    <div className="stat-row">
      <span>{label}</span>
      <span className={"v" + (big ? " big" : "")} style={{ color }}>
        {value}
        {delta && <span className="delta" style={{ color: deltaColor }}>{delta}</span>}
      </span>
    </div>
  );
}

export function Dot({ color, size = 7 }: { color: string; size?: number }) {
  return <span className="dot" style={{ background: color, width: size, height: size, boxShadow: `0 0 6px ${color}88` }} />;
}

export const Icon = {
  bell: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0" /></svg>,
  gear: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>,
  user: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>,
  chev: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>,
  expand: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>,
  cursor: <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M4 2l16 8-7 2-2 7z" /></svg>,
  hand: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 11V6a2 2 0 0 0-4 0v1M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.9-2.5L2.4 14.7a2 2 0 0 1 3.2-2.4L7 14" /></svg>,
  path: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="5" cy="19" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><path d="M6.5 17.5 10.5 13.5M13.5 10.5 17.5 6.5" /></svg>,
  tag: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h7l9 9-7 7-9-9z" /><circle cx="8" cy="8" r="1.5" /></svg>,
  ruler: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 16 16 2l6 6L8 22zM7 11l2 2M10 8l2 2M13 5l2 2" /></svg>,
  play: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4l14 8-14 8z" /></svg>,
  pause: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>,
  reset: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>,
  bolt: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 3 14h8l-1 8 10-12h-8z" /></svg>,
  brain: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9.5 2a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 1 5.8A3 3 0 0 0 9 21h1V2zM14.5 2a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-1 5.8A3 3 0 0 1 15 21h-1V2z" /></svg>,
  fork: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="6" cy="4" r="2" /><circle cx="18" cy="4" r="2" /><circle cx="12" cy="20" r="2" /><path d="M6 6v2a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V6M12 12v6" /></svg>,
  check: <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="m5 12 5 5L20 7" /></svg>,
  warn: <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 1 21h22z" /></svg>,
};
