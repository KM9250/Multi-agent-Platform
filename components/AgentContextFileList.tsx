import React from 'react';
import { FileText, Trash2, Upload } from 'lucide-react';
import { AgentContextFile } from '../types';

interface Props { files: AgentContextFile[]; errors: string[]; onAdd: () => void; onDelete: (id: string) => void; onMove: (id: string, dir: -1 | 1) => void; }

const AgentContextFileList: React.FC<Props> = ({ files, errors, onAdd, onDelete, onMove }) => {
  const sorted = files.slice().sort((a, b) => a.order - b.order);
  const totalChars = sorted.reduce((sum, f) => sum + f.charCount, 0);
  return <div className="space-y-2">
    <div className="flex items-center justify-between">
      <label className="block text-sm font-medium text-zinc-300">Additional Context (.md files)</label>
      <button type="button" onClick={onAdd} className="text-xs flex items-center gap-1 text-blue-400 hover:text-blue-300 px-2 py-1 rounded bg-blue-500/10 border border-blue-500/20"><Upload className="w-3 h-3" /> Add files</button>
    </div>
    {sorted.length === 0 ? <button type="button" onClick={onAdd} className="w-full border border-dashed border-zinc-700 rounded-lg p-4 flex flex-col items-center justify-center text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800/50 transition-all"><Upload className="w-5 h-5 mb-2" /><span className="text-xs font-medium">Click to upload .md, .markdown, or .txt files</span></button> : <div className="space-y-2">
      {sorted.map((file, index) => <div key={file.id} className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50 gap-2">
        <div className="flex items-center gap-3 min-w-0"><div className="p-2 bg-zinc-800 rounded border border-zinc-700"><FileText className="w-4 h-4 text-blue-400" /></div><div className="min-w-0"><div className="text-sm text-zinc-200 truncate font-medium">{index + 1}. {file.name}</div><div className="text-[10px] text-zinc-500">{file.charCount.toLocaleString()} characters · order {file.order}</div></div></div>
        <div className="flex items-center gap-1"><button type="button" disabled={index===0} onClick={() => onMove(file.id, -1)} className="px-2 py-1 text-xs text-zinc-400 disabled:opacity-30">↑</button><button type="button" disabled={index===sorted.length-1} onClick={() => onMove(file.id, 1)} className="px-2 py-1 text-xs text-zinc-400 disabled:opacity-30">↓</button><button type="button" onClick={() => onDelete(file.id)} className="p-2 hover:bg-red-500/10 hover:text-red-400 text-zinc-500 rounded-lg"><Trash2 className="w-4 h-4" /></button></div>
      </div>)}
    </div>}
    <div className="text-[11px] text-zinc-500">{sorted.length} files / {totalChars.toLocaleString()} characters</div>
    {errors.map(err => <div key={err} className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">{err}</div>)}
  </div>;
};
export default AgentContextFileList;
