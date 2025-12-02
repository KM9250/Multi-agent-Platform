
import React, { useState, useEffect } from 'react';
import { X, Box, Gamepad2, AlertTriangle, Info } from 'lucide-react';
import { RoomTag } from '../types';
import { ROOM_TAGS } from '../constants';

interface RoomModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (title: string, description: string, type: RoomTag) => void;
}

const RoomModal: React.FC<RoomModalProps> = ({ isOpen, onClose, onSave }) => {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<RoomTag>('Sandbox');

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setDescription('');
      setType('Sandbox');
    }
  }, [isOpen]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (title.trim()) {
      onSave(title, description, type);
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
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <div className="flex justify-between items-center p-5 border-b border-zinc-800 bg-zinc-900 z-10 rounded-t-2xl">
          <h2 className="text-xl font-bold text-white">Create New Room</h2>
          <button onClick={onClose} className="p-2 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

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
              autoFocus
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Description (Optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 resize-none"
              placeholder="What is this conversation about?"
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
                    relative flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all duration-200
                    ${type === tag.value 
                      ? 'bg-zinc-800 border-blue-500/50 ring-1 ring-blue-500/30' 
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
                  <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800">
                     {getTagIcon(tag.value)}
                  </div>
                  <div>
                    <div className="font-medium text-sm text-zinc-200">{tag.label}</div>
                    <div className="text-[10px] text-zinc-500">
                      {tag.value === 'Sandbox' && 'No long-term memory constraints.'}
                      {tag.value === 'Recreation' && 'Casual memory persistence.'}
                      {tag.value === 'Hard' && 'Strict facts and continuity enforced.'}
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
              Create Room
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default RoomModal;
