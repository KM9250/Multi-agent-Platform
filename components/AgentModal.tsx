
import React, { useState, useEffect, useRef } from 'react';
import { X, Shuffle, Brain, Upload, Image as ImageIcon, Smile, FileText, Trash2, Cpu } from 'lucide-react';
import { Agent, ModelType, AgentFramework } from '../types';
import { AVATAR_COLORS, MODEL_OPTIONS, FRAMEWORK_OPTIONS } from '../constants';
import { getStrategy } from '../services/agentStrategies';

interface AgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (agent: Agent) => void;
  editingAgent?: Agent | null;
}

const AgentModal: React.FC<AgentModalProps> = ({ isOpen, onClose, onSave, editingAgent }) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systemInstruction, setSystemInstruction] = useState('');
  const [model, setModel] = useState<string>(ModelType.GEMINI_2_5_FLASH);
  const [framework, setFramework] = useState<AgentFramework>('standard');
  
  // Imported System Instruction State
  const [importedInstruction, setImportedInstruction] = useState<string>('');
  const [importedFileName, setImportedFileName] = useState<string>('');

  // Avatar state
  const [avatarType, setAvatarType] = useState<'emoji' | 'image'>('emoji');
  const [emojiAvatar, setEmojiAvatar] = useState('🤖');
  const [imageAvatar, setImageAvatar] = useState<string>('');
  
  const [color, setColor] = useState(AVATAR_COLORS[0]);
  const [thinkingBudget, setThinkingBudget] = useState<number>(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const mdInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingAgent) {
      setName(editingAgent.name);
      setDescription(editingAgent.description);
      setSystemInstruction(editingAgent.systemInstruction);
      setImportedInstruction(editingAgent.importedSystemInstruction || '');
      setImportedFileName(editingAgent.importedSystemInstructionFileName || '');
      setModel(editingAgent.model);
      setFramework(editingAgent.framework || 'standard');
      setColor(editingAgent.color);
      setThinkingBudget(editingAgent.thinkingBudget);
      
      if (editingAgent.avatarType === 'image') {
        setAvatarType('image');
        setImageAvatar(editingAgent.avatar);
        setEmojiAvatar('🤖'); // Reset to default fallback
      } else {
        setAvatarType('emoji');
        setEmojiAvatar(editingAgent.avatar);
        setImageAvatar('');
      }
    } else {
      resetForm();
    }
  }, [editingAgent, isOpen]);

  const resetForm = () => {
    setName('');
    setDescription('');
    setSystemInstruction('You are a helpful AI assistant.');
    setImportedInstruction('');
    setImportedFileName('');
    setModel(ModelType.GEMINI_2_5_FLASH);
    setFramework('standard');
    setAvatarType('emoji');
    setEmojiAvatar('🤖');
    setImageAvatar('');
    setColor(AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]);
    setThinkingBudget(0);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // If the image tab is selected but nothing was uploaded, fall back to the
    // emoji avatar entirely — saving avatarType 'image' with an emoji string
    // would render a broken <img> everywhere the avatar is shown.
    const effectiveAvatarType = avatarType === 'image' && imageAvatar ? 'image' : 'emoji';
    onSave({
      id: editingAgent ? editingAgent.id : crypto.randomUUID(),
      name: name || 'Unnamed Agent',
      description,
      systemInstruction,
      importedSystemInstruction: importedInstruction,
      importedSystemInstructionFileName: importedFileName,
      model,
      framework,
      color,
      avatar: effectiveAvatarType === 'image' ? imageAvatar : emojiAvatar,
      avatarType: effectiveAvatarType,
      isEnabled: editingAgent ? editingAgent.isEnabled : true,
      thinkingBudget
    });
    onClose();
  };

  const generateRandomAvatar = () => {
    const emojis = ['🤖', '👽', '👻', '🤡', '🤠', '🧠', '⚡', '🐉', '🦉', '🦊', '🐯', '🦄', '🐳', '🦖'];
    setEmojiAvatar(emojis[Math.floor(Math.random() * emojis.length)]);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // Create canvas for cropping/resizing
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const size = 128; // Standardize size
        
        canvas.width = size;
        canvas.height = size;

        // Calculate center crop
        const minDim = Math.min(img.width, img.height);
        const sx = (img.width - minDim) / 2;
        const sy = (img.height - minDim) / 2;

        if (ctx) {
          ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.85); // Compress slightly
          setImageAvatar(dataUrl);
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const handleMdUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      setImportedInstruction(text);
      setImportedFileName(file.name);
    };
    reader.readAsText(file);
    // Reset value so same file can be selected again if needed
    if (mdInputRef.current) mdInputRef.current.value = '';
  };

  const clearImportedFile = () => {
    setImportedInstruction('');
    setImportedFileName('');
  };

  if (!isOpen) return null;
  
  const currentStrategy = getStrategy(framework);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl animate-in fade-in zoom-in-95 duration-200">
        <div className="flex justify-between items-center p-5 border-b border-zinc-800 sticky top-0 bg-zinc-900 z-10">
          <h2 className="text-xl font-bold text-white">
            {editingAgent ? 'Edit Agent' : 'Create New Agent'}
          </h2>
          <button onClick={onClose} className="p-2 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Identity Section */}
          <div className="flex flex-col sm:flex-row gap-6">
            
            {/* Avatar Selector */}
            <div className="shrink-0 flex flex-col items-center space-y-3">
              <div 
                className={`w-20 h-20 rounded-2xl flex items-center justify-center text-4xl shadow-lg ring-2 ring-zinc-800 overflow-hidden relative ${avatarType === 'emoji' ? color : 'bg-zinc-800'}`}
              >
                {avatarType === 'emoji' ? (
                  <span>{emojiAvatar}</span>
                ) : (
                  imageAvatar ? (
                    <img src={imageAvatar} alt="Avatar" className="w-full h-full object-cover" />
                  ) : (
                    <ImageIcon className="w-8 h-8 text-zinc-500" />
                  )
                )}
              </div>

              {/* Toggle Switch */}
              <div className="flex p-1 bg-zinc-800 rounded-lg w-full max-w-[140px]">
                <button
                  type="button"
                  onClick={() => setAvatarType('emoji')}
                  className={`flex-1 flex items-center justify-center py-1.5 rounded text-xs font-medium transition-all ${
                    avatarType === 'emoji' ? 'bg-zinc-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-300'
                  }`}
                  title="Use Emoji"
                >
                  <Smile className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setAvatarType('image')}
                  className={`flex-1 flex items-center justify-center py-1.5 rounded text-xs font-medium transition-all ${
                    avatarType === 'image' ? 'bg-zinc-600 text-white shadow' : 'text-zinc-400 hover:text-zinc-300'
                  }`}
                  title="Upload Image"
                >
                  <ImageIcon className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Action Buttons based on Type */}
              {avatarType === 'emoji' ? (
                <div className="flex gap-2">
                   <button 
                    type="button" 
                    onClick={generateRandomAvatar}
                    className="text-xs flex items-center gap-1 text-zinc-400 hover:text-zinc-200 px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 transition-colors"
                  >
                    <Shuffle className="w-3 h-3" /> Random
                  </button>
                   <button 
                    type="button" 
                    onClick={() => setColor(AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)])}
                    className="w-6 h-6 rounded-full border border-zinc-600 bg-gradient-to-tr from-blue-500 to-purple-500 hover:opacity-80 transition-opacity"
                    title="Change Color"
                  />
                </div>
              ) : (
                <>
                  <input 
                    type="file" 
                    ref={fileInputRef}
                    accept="image/*"
                    onChange={handleImageUpload}
                    className="hidden"
                  />
                  <button 
                    type="button" 
                    onClick={() => fileInputRef.current?.click()}
                    className="text-xs flex items-center gap-1 text-blue-400 hover:text-blue-300 px-3 py-1.5 rounded bg-blue-500/10 hover:bg-blue-500/20 transition-colors border border-blue-500/20"
                  >
                    <Upload className="w-3 h-3" /> Upload
                  </button>
                </>
              )}
            </div>

            {/* Inputs */}
            <div className="flex-1 space-y-4">
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  placeholder="e.g. Code Master"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-zinc-300 mb-1">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50"
                  placeholder="Short role description"
                />
              </div>
            </div>
          </div>

          <div className="border-t border-zinc-800 my-4" />

          {/* Model Config */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">Model</label>
              <div className="relative">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:ring-2 focus:ring-blue-500/50 appearance-none"
                >
                  {MODEL_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
            </div>
            
            <div className="border border-zinc-800 rounded-lg p-3 bg-zinc-900/50">
              <div className="flex items-center justify-between mb-2">
                <label className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                  <Brain className="w-4 h-4 text-purple-400" />
                  Reasoning (Budget)
                </label>
                <span className="text-xs font-mono text-zinc-500">{thinkingBudget > 0 ? `${thinkingBudget} tokens` : 'Off'}</span>
              </div>
              <input
                type="range"
                min="0"
                max="8192"
                step="1024"
                value={thinkingBudget}
                onChange={(e) => setThinkingBudget(Number(e.target.value))}
                className="w-full h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
              <p className="text-[10px] text-zinc-500 mt-1">
                Higher values allow more "thinking" before answering (Gemini 2.5 only).
              </p>
            </div>
          </div>

          {/* Framework Strategy Config */}
          <div className="border border-zinc-800 rounded-lg p-3 bg-zinc-900/30">
             <label className="flex items-center gap-2 text-sm font-medium text-zinc-300 mb-2">
                <Cpu className="w-4 h-4 text-teal-400" />
                Agent Framework / Strategy
             </label>
             <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
               {FRAMEWORK_OPTIONS.map((opt) => (
                 <button
                   key={opt.value}
                   type="button"
                   onClick={() => setFramework(opt.value)}
                   className={`
                     px-3 py-2 rounded-lg text-xs font-medium border transition-all text-left
                     ${framework === opt.value 
                       ? 'bg-teal-500/10 text-teal-300 border-teal-500/30' 
                       : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:bg-zinc-800'}
                   `}
                 >
                   {opt.label}
                 </button>
               ))}
             </div>
             <p className="text-[10px] text-zinc-500 mt-2">
               {currentStrategy.description}
             </p>
          </div>

          {/* System Prompt */}
          <div>
            <div className="flex justify-between items-center mb-1">
               <label className="block text-sm font-medium text-zinc-300">System Instructions (Manual)</label>
            </div>
            <textarea
              value={systemInstruction}
              onChange={(e) => setSystemInstruction(e.target.value)}
              rows={4}
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 font-mono text-sm resize-none"
              placeholder="How should this agent behave?"
            />
            
            {/* Markdown File Upload */}
            <div className="mt-4">
              <label className="block text-sm font-medium text-zinc-300 mb-2">Additional Context (.md file)</label>
              {importedFileName ? (
                <div className="flex items-center justify-between p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/50">
                   <div className="flex items-center gap-3 overflow-hidden">
                      <div className="p-2 bg-zinc-800 rounded border border-zinc-700">
                        <FileText className="w-4 h-4 text-blue-400" />
                      </div>
                      <div className="flex flex-col min-w-0">
                        <span className="text-sm text-zinc-200 truncate font-medium">{importedFileName}</span>
                        <span className="text-[10px] text-zinc-500">
                          {importedInstruction.length} characters loaded
                        </span>
                      </div>
                   </div>
                   <button 
                     type="button"
                     onClick={clearImportedFile} 
                     className="p-2 hover:bg-red-500/10 hover:text-red-400 text-zinc-500 rounded-lg transition-colors"
                     title="Remove file"
                   >
                      <Trash2 className="w-4 h-4" />
                   </button>
                </div>
              ) : (
                <div 
                   onClick={() => mdInputRef.current?.click()}
                   className="border border-dashed border-zinc-700 rounded-lg p-4 flex flex-col items-center justify-center text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 hover:bg-zinc-800/50 transition-all cursor-pointer group"
                >
                   <Upload className="w-5 h-5 mb-2 group-hover:-translate-y-0.5 transition-transform" />
                   <span className="text-xs font-medium">Click to upload .md file</span>
                </div>
              )}
              <input 
                type="file" 
                accept=".md, .txt, .markdown" 
                className="hidden" 
                ref={mdInputRef} 
                onChange={handleMdUpload} 
              />
            </div>
          </div>

          <div className="pt-2">
            <button
              type="submit"
              className="w-full bg-white text-black font-semibold py-2.5 rounded-lg hover:bg-zinc-200 transition-colors"
            >
              {editingAgent ? 'Save Changes' : 'Create Agent'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AgentModal;
