import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Shield } from 'lucide-react';
import type { InternalStateSettings, Message } from '../types';
import { deriveLegacySegments } from '../utils/messageVisibility';

export default function InternalStatePanel({ message, settings }: { message: Message; settings: InternalStateSettings }) {
  const [open, setOpen] = useState(false);
  const visible = deriveLegacySegments(message).filter(segment => {
    if (segment.channel === 'shared_summary') return true;
    if (segment.channel === 'private_state') return settings.showPrivateState;
    if (segment.channel === 'debug_thoughts') return settings.showDebugThoughts;
    if (segment.channel === 'gm_log') return settings.showGmLog;
    if (segment.channel === 'memory_export') return settings.showMemoryExport;
    return false;
  });
  if (!settings.enabled || !visible.length) return null;
  const labels = { private_state: 'Private', shared_summary: 'Shared', debug_thoughts: 'Debug', gm_log: 'GM', memory_export: 'Memory', public_message: 'Public' };
  return <div className="mt-2 ml-1 mr-1 rounded border border-indigo-500/20 bg-indigo-950/10">
    <button className="flex w-full items-center gap-2 px-2 py-1.5 text-[10px] text-indigo-300" onClick={() => setOpen(v => !v)}>
      <Shield className="w-3 h-3" /><span className="flex-1 text-left uppercase tracking-wider">Internal information</span>{open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
    </button>
    {open && <div className="space-y-2 border-t border-indigo-500/20 p-2">{visible.map(segment => <div key={segment.id} className="rounded bg-zinc-950/70 p-2 text-xs text-zinc-400 whitespace-pre-wrap"><strong className="mb-1 block text-[9px] uppercase text-indigo-300">{labels[segment.channel]} · {segment.visibility}</strong>{segment.content}</div>)}</div>}
  </div>;
}
