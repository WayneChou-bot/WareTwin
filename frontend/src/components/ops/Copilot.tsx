/**
 * AI Operations Copilot 對話（規格 1️⃣6️⃣）
 * online：COPILOT_ASK → 後端 LLM（或規則式 fallback）→ COPILOT_REPLY；引用 (R03 / A3812 / E123) 可點擊。
 * local：無後端時提示。
 */
import { useEffect, useRef, useState } from "react";
import { useStore } from "../../state/store";
import { wsSend, onCopilotReply, API_URL } from "../../services/ws";

interface Msg { role: "user" | "ai"; text: string; citations?: Array<{ robot_id?: string; task_id?: string; event_id?: string }>; model?: string; pending?: boolean; request_id?: string }

const SUGGESTIONS = [
  "Why is throughput dropping?",
  "Which robot is likely to fail?",
  "Why is Zone B congested?",
  "Which robot should handle the next waiting task?",
  "How can we improve throughput?",
  "Which conveyor is the bottleneck?",
];

export function Copilot() {
  const source = useStore((s) => s.source);
  const select = useStore((s) => s.select);
  const setModal = useStore((s) => s.setModal);
  const tasks = useStore((s) => s.twin.tasks);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [q, setQ] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const [ai, setAi] = useState<{ llm: boolean; model: string } | null>(null);
  useEffect(() => {
    if (source !== "online") { setAi(null); return; }
    fetch(`${API_URL}/api/ai/status`).then((r) => r.json()).then(setAi).catch(() => setAi(null));
  }, [source]);

  useEffect(() => onCopilotReply((r) => {
    setMsgs((m) => m.map((x) => (x.pending && x.request_id === r.request_id ? { role: "ai", text: r.text, citations: r.citations, model: r.model } : x)));
  }), []);
  useEffect(() => { listRef.current?.scrollTo({ top: 1e6 }); }, [msgs]);

  const ask = (question: string) => {
    const text = question.trim(); if (!text) return;
    // 把「next waiting task」換成實際任務 id，讓回答可引用
    const waiting = Object.values(tasks).find((t) => t.status === "WAITING");
    const sent = waiting ? text.replace(/the next waiting task/i, waiting.id) : text;
    const request_id = `q${++seq.current}`;
    setMsgs((m) => [...m, { role: "user", text: sent }, { role: "ai", text: "…", pending: true, request_id }]);
    setQ("");
    if (source !== "online") { setMsgs((m) => m.map((x) => (x.request_id === request_id ? { role: "ai", text: "Copilot runs on the backend. Start `uvicorn app.main:app` (the LOCAL badge means the backend is unreachable)." } : x))); return; }
    wsSend({ type: "COPILOT_ASK", request_id, question: sent });
  };

  const renderText = (t: string) => t.split(/(\b(?:R\d{2}|A\d{4}|E\d+|CV\d{2}|Zone [A-D])\b)/g).map((part, i) => {
    if (/^R\d{2}$/.test(part)) return <button key={i} className="cite" onClick={() => select(part)}>{part}</button>;
    if (/^A\d{4}$/.test(part)) return <button key={i} className="cite" onClick={() => setModal("tasks")}>{part}</button>;
    if (/^E\d+$/.test(part)) return <button key={i} className="cite" onClick={() => setModal("audit")}>{part}</button>;
    return <span key={i}>{part}</span>;
  });

  return (
    <div className="copilot">
      {ai && <div className={"ai-mode " + (ai.llm ? "llm" : "demo")}>{ai.llm ? `LLM mode · ${ai.model}` : "Demo mode · rule-based analysis of the live twin state (no API key configured — set OPENAI_API_KEY on the backend to enable the LLM)"}</div>}
      <div className="chips">{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => ask(s)}>{s}</button>)}</div>
      <div className="chat" ref={listRef}>
        {msgs.length === 0 && <div className="hint">Ask about throughput, congestion, robot health, task assignment or failure scenarios. Answers are grounded in the live twin state and cite robots / tasks / events you can click.</div>}
        {msgs.map((m, i) => (
          <div key={i} className={"msg " + m.role}>
            <div className="bubble">{m.pending ? <span className="typing">Analysing twin state…</span> : renderText(m.text)}</div>
            {m.role === "ai" && !m.pending && (
              <div className="msg-meta">
                {m.model && <span className="model">{m.model}</span>}
                {m.citations && m.citations.length > 0 && <span>· cites {m.citations.map((c, j) => <button key={j} className="cite" onClick={() => { if (c.robot_id) select(c.robot_id); else if (c.task_id) setModal("tasks"); else setModal("audit"); }}>{c.robot_id ?? c.task_id ?? c.event_id}</button>)}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
      <form className="ask" onSubmit={(e) => { e.preventDefault(); ask(q); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ask the Operations Copilot…" />
        <button className="btn primary" type="submit">Ask</button>
      </form>
    </div>
  );
}
