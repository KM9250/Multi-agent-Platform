import React, { useMemo, useState } from 'react';
import { Activity, ChevronDown, ChevronRight } from 'lucide-react';
import { AgentDecisionEvent } from '../types';

interface Props { events: AgentDecisionEvent[]; }

const statusClass = (outcome: string) => outcome === 'RESPOND' ? 'text-emerald-400' : outcome === 'IGNORE' ? 'text-zinc-400' : 'text-red-400';

const DecisionDiagnosticsPanel: React.FC<Props> = ({ events }) => {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const grouped = useMemo(() => {
    const map = new Map<string, AgentDecisionEvent[]>();
    events.slice().reverse().forEach(event => map.set(event.turnId, [...(map.get(event.turnId) || []), event]));
    return Array.from(map.entries()).slice(0, 8);
  }, [events]);

  return <div className="border-b border-zinc-800 bg-zinc-950/90">
    <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between px-4 py-2 text-xs text-zinc-400 hover:text-zinc-200">
      <span className="flex items-center gap-2"><Activity className="w-4 h-4 text-blue-400" /> Turn Diagnostics <span className="text-zinc-600">({events.length})</span></span>
      {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
    </button>
    {open && <div className="max-h-72 overflow-y-auto px-4 pb-3 space-y-3">
      {grouped.length === 0 ? <p className="text-xs text-zinc-600">No decision events yet.</p> : grouped.map(([turnId, items]) => <div key={turnId} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3">
        <div className="flex items-center justify-between text-[11px] text-zinc-500 mb-2">
          <span>Turn {turnId.slice(0, 8)}…</span>
          <span>{new Date(items[0].timestamp).toLocaleTimeString()}</span>
        </div>
        <div className="space-y-2">
          {items.map(event => <div key={event.id} className="text-xs">
            <button type="button" onClick={() => setExpanded(expanded === event.id ? null : event.id)} className="w-full text-left hover:bg-zinc-800/60 rounded p-1">
              <div className="font-medium text-zinc-200">{event.agentName}</div>
              <div className="flex gap-1 items-center"><span className={statusClass(event.outcome)}>{event.outcome}</span><span>·</span><span>{event.source}</span><span>·</span><span>{event.latencyMs.toLocaleString()} ms</span></div>
              {event.errorCode && <div className="text-red-400 mt-0.5">{event.errorCode}</div>}
            </button>
            {expanded === event.id && <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 mt-1 p-2 bg-zinc-950 rounded text-[11px] text-zinc-400 break-all">
              {Object.entries(event).filter(([k]) => k !== 'id').map(([k, v]) => <React.Fragment key={k}><dt className="text-zinc-600">{k}</dt><dd>{String(v ?? '')}</dd></React.Fragment>)}
            </dl>}
          </div>)}
        </div>
      </div>)}
    </div>}
  </div>;
};

export default DecisionDiagnosticsPanel;
