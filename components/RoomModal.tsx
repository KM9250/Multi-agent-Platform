
import React, { useState, useEffect } from 'react';
import { X, Box, Gamepad2, AlertTriangle, Info, CheckCircle2 } from 'lucide-react';
import { RoomTag, Room } from '../types';
import { ROOM_TAGS } from '../constants';

interface RoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (title: string, description: string, type: RoomTag, systemInstruction: string) => void;
  editingRoom?: Room | null;
}

const RoomModal: React.FC<RoomModalProps> = ({ isOpen, onClose, onSave, editingRoom }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [systemInstruction, setSystemInstruction] = useState('');
  const [type, setType] = useState<RoomTag>('Sandbox');

  useEffect(() => {
    if (isOpen) {
      if (editingRoom) {
        setTitle(editingRoom.title);
        setDescription(editingRoom.description);
        setSystemInstruction(editingRoom.systemInstruction || '');
        setType(editingRoom.type);
      } else {
        setTitle('');
        setDescription('');
        setSystemInstruction('');
        setType('Sandbox');
      }
    }
  }, [isOpen, editingRoom]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onSave(title, description, type, systemInstruction);
      onClose();
    }
  };

  const getTagIcon = (tag: RoomTag) => {
    switch (tag) {
      case 'Sandbox': return <Box className="w-5 h-5 text-emerald-400" />;
      case 'Recreation': return <Gamepad2 className="w-5 h-5 text-blue-400" />;
      case 'Hard': return <AlertTriangle className="w-5 h-5 text-red-400" />;
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <div className="flex justify-between items-center p-5 border-b border-zinc-800 bg-zinc-900 z-10 rounded-t-2xl shrink-0">
          <h2 className="text-xl font-bold text-white">{editingRoom ? 'Edit Room Settings' : 'Create New Room'}</h2>
          <button onClick={onClose} className="p-2 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto custom-scrollbar">
          <form onSubmit={handleSubmit} className="p-6 space-y-6">
            {/* Title */}
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">Room Name</label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                placeholder="e.g. Project Alpha"
              />
            </div>

            {/* Description */}
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">Description (Optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
                placeholder="Short topic description"
              />
            </div>
            
            {/* Shared System Instruction */}
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1 flex items-center gap-2">
                Shared System Instructions
                <span className="text-[10px] text-zinc-500 font-normal px-2 py-0.5 border border-zinc-700 rounded-full">For All Agents</span>
              </label>
              <textarea
                value={systemInstruction}
                onChange={(e) => setSystemInstruction(e.target.value)}
                rows={4}
                className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 font-mono text-xs resize-none"
                placeholder="Define a shared goal, world setting, or rules that apply to every agent in this room..."
              />
            </div>

            {/* Tags */}
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-3 flex items-center gap-2">
                Memory Mode <Info className="w-3.5 h-3.5 text-zinc-500" />
              </label>
              <div className="grid grid-cols-1 gap-3">
                {ROOM_TAGS.map((tag) => (
                  <label 
                    key={tag.value}
                    className={`
                      relative flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all duration-200 group
                      ${type === tag.value 
                        ? 'bg-zinc-800 border-zinc-600 ring-1 ring-zinc-500 shadow-inner' 
                        : 'bg-zinc-900 border-zinc-800 hover:bg-zinc-800/50 hover:border-zinc-700'}
                    `}
                  >
                    <input
                      type="radio"
                      name="roomType"
                      value={tag.value}
                      checked={type === tag.value}
                      onChange={() => setType(tag.value)}
                      className="hidden"
                    />
                    <div className={`p-2 rounded-lg bg-zinc-950 border border-zinc-800 group-hover:scale-110 transition-transform duration-200`}>
                       {getTagIcon(tag.value)}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center justify-between">
                        <div className="font-medium text-sm text-zinc-200">{tag.label}</div>
                        {type === tag.value && <CheckCircle2 className="w-4 h-4 text-blue-500 animate-in fade-in" />}
                      </div>
                      <div className="text-[10px] text-zinc-500 mt-0.5">
                        {tag.description}
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="pt-2">
              <button
                type="submit"
                disabled={!title.trim()}
                className="w-full bg-white text-black font-semibold py-2.5 rounded-lg hover:bg-zinc-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editingRoom ? 'Save Changes' : 'Create Room'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};

export default RoomModal;
