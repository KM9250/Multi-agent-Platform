
import React, { useMemo, useState } from 'react';
import { User, Copy, AlertCircle, FileText, ChevronDown, ChevronRight, Brain } from 'lucide-react';
import { Message, Agent } from '../types';

interface MessageBubbleProps {
  message: Message;
  agent?: Agent; // Undefined if user
}

interface Emotion {
  name: string;
  value: number;
}

// Generate a consistent color based on the emotion name
const getEmotionColor = (name: string): string => {
  const colors = [
    'bg-red-500', 'bg-orange-500', 'bg-amber-500', 'bg-yellow-500', 'bg-lime-500',
    'bg-green-500', 'bg-emerald-500', 'bg-teal-500', 'bg-cyan-500', 'bg-sky-500',
    'bg-blue-500', 'bg-indigo-500', 'bg-violet-500', 'bg-purple-500', 'bg-fuchsia-500', 'bg-pink-500', 'bg-rose-500'
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

const MessageBubble: React.FC<MessageBubbleProps> = ({ message, agent }) => {
  const [isThoughtOpen, setIsThoughtOpen] = useState(false);
  const isUser = message.role === 'user';
  
  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
  };

  const { emotions, cleanContent, thoughtContent, actionContent } = useMemo(() => {
    if (isUser || !message.content) {
      return { emotions: [], cleanContent: message.content, thoughtContent: null, actionContent: null };
    }

    let currentContent = message.content;
    const emotions: Emotion[] = [];

    // 1. Extract Emotions (at start)
    const emotionRegex = /【([^】]+)】(\d+)%/g;
    const startBlockRegex = /^((?:【[^】]+】\d+%)+)(.*)/s;
    const blockMatch = currentContent.match(startBlockRegex);

    if (blockMatch) {
        const emotionBlock = blockMatch[1];
        currentContent = blockMatch[2].replace(/^\s+/, '');
        
        let match;
        while ((match = emotionRegex.exec(emotionBlock)) !== null) {
            emotions.push({
                name: match[1],
                value: parseInt(match[2], 10)
            });
        }
    }

    // 2. Extract Thoughts [THOUGHT]...[/THOUGHT]
    let thoughtContent = null;
    const thoughtRegex = /\[THOUGHT\]([\s\S]*?)\[\/THOUGHT\]/;
    const thoughtMatch = currentContent.match(thoughtRegex);
    if (thoughtMatch) {
      thoughtContent = thoughtMatch[1].trim();
      currentContent = currentContent.replace(thoughtRegex, '').trim();
    }

    // 3. Extract Actions [ACTION]...[/ACTION]
    let actionContent = null;
    const actionRegex = /\[ACTION\]([\s\S]*?)\[\/ACTION\]/;
    const actionMatch = currentContent.match(actionRegex);
    if (actionMatch) {
      actionContent = actionMatch[1].trim();
      currentContent = currentContent.replace(actionRegex, '').trim();
    }
    
    // Clean up "Final Response:" markers if left over from ReAct
    currentContent = currentContent.replace(/^Final Response:\s*/i, '');

    return { 
        emotions, 
        cleanContent: currentContent,
        thoughtContent,
        actionContent
    };
  }, [message.content, isUser]);

  return (
    <div className={`flex w-full mb-6 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`flex max-w-[95%] md:max-w-[85%] gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
        
        {/* Avatar */}
        <div className="shrink-0 mt-1">
          {isUser ? (
            <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-zinc-300 border border-zinc-600">
              <User className="w-5 h-5" />
            </div>
          ) : (
            <div 
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm shadow-sm border border-white/10 overflow-hidden ${agent?.avatarType === 'image' ? 'bg-zinc-800' : (agent?.color || 'bg-zinc-600')}`}
              title={agent?.name}
            >
              {agent?.avatarType === 'image' ? (
                <img src={agent.avatar} alt={agent.name} className="w-full h-full object-cover" />
              ) : (
                agent?.avatar || '🤖'
              )}
            </div>
          )}
        </div>

        {/* Content Bubble Wrapper */}
        <div className="flex flex-col min-w-0 flex-1">
          {!isUser && agent && (
            <div className="flex items-center gap-2 mb-1 ml-1">
                <span className="text-xs text-zinc-400 font-medium">
                {agent.name}
                </span>
                {agent.thinkingBudget > 0 && <span className="text-[9px] bg-purple-500/20 text-purple-300 px-1 rounded border border-purple-500/30">Thinking</span>}
                {agent.framework && agent.framework !== 'standard' && (
                  <span className="text-[9px] bg-teal-500/20 text-teal-300 px-1 rounded border border-teal-500/30 uppercase">{agent.framework}</span>
                )}
            </div>
          )}

          {!isUser && emotions.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2 ml-1">
              {emotions.map((e, idx) => {
                 const colorClass = getEmotionColor(e.name);
                 return (
                    <div key={idx} className="flex items-center gap-1.5 bg-zinc-800/80 border border-zinc-700/50 rounded px-2 py-0.5 text-[10px] text-zinc-300">
                        <span className="font-medium opacity-90">{e.name}</span>
                        <div className="w-12 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                            <div 
                                className={`h-full rounded-full ${colorClass}`} 
                                style={{ width: `${Math.min(e.value, 100)}%` }}
                            />
                        </div>
                        <span className="w-6 text-right font-mono opacity-70">{e.value}%</span>
                    </div>
                 );
              })}
            </div>
          )}

          {/* Thought Process (Collapsible) */}
          {!isUser && thoughtContent && (
             <div className="mb-2 ml-1 mr-1">
                <button 
                  onClick={() => setIsThoughtOpen(!isThoughtOpen)}
                  className="flex items-center gap-1.5 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors bg-zinc-900/50 px-2 py-1 rounded border border-zinc-800 w-full text-left"
                >
                  <Brain className="w-3 h-3" />
                  <span className="font-mono uppercase tracking-wider flex-1">Agent thought process</span>
                  {isThoughtOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                </button>
                {isThoughtOpen && (
                  <div className="mt-1 p-2 bg-zinc-900 border border-zinc-800 rounded text-xs text-zinc-400 font-mono whitespace-pre-wrap leading-relaxed animate-in slide-in-from-top-1 fade-in duration-200">
                    {thoughtContent}
                  </div>
                )}
             </div>
          )}
          
          <div 
            className={`
              relative px-4 py-3 rounded-2xl text-sm leading-relaxed overflow-hidden group shadow-sm
              ${isUser 
                ? 'bg-zinc-800 text-zinc-100 rounded-tr-sm border border-zinc-700' 
                : 'bg-zinc-900/80 text-zinc-200 rounded-tl-sm border border-zinc-800/80'}
              ${message.error ? 'border-red-500/50 bg-red-900/10' : ''}
            `}
          >
            {/* Action Display (ReAct) */}
            {actionContent && (
               <div className="mb-3 p-2 bg-teal-900/20 border border-teal-500/20 rounded-lg text-xs font-mono text-teal-300">
                  <strong className="block mb-1 text-[9px] uppercase tracking-widest text-teal-500">Suggested Action</strong>
                  {actionContent}
               </div>
            )}

            {/* Attachment Display */}
            {message.attachments && message.attachments.length > 0 && (
               <div className="flex flex-wrap gap-2 mb-3">
                  {message.attachments.map((att, idx) => (
                    <div key={idx} className="overflow-hidden rounded-lg border border-white/10 bg-black/20">
                      {att.type === 'image' ? (
                        <div className="relative group/img cursor-pointer">
                           <img 
                              src={att.data} 
                              alt={att.name} 
                              className="max-w-[200px] max-h-[200px] object-cover" 
                           />
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 px-3 py-2">
                           <FileText className="w-4 h-4 text-zinc-400" />
                           <span className="text-xs text-zinc-300 max-w-[150px] truncate">{att.name}</span>
                        </div>
                      )}
                    </div>
                  ))}
               </div>
            )}

            {message.error ? (
               <div className="flex items-center gap-2 text-red-400">
                  <AlertCircle className="w-4 h-4" />
                  <span>Error: {cleanContent}</span>
               </div>
            ) : (
              <div className="whitespace-pre-wrap break-words">
                {cleanContent || (message.isStreaming ? '' : <span className="text-zinc-500 italic">No text content</span>)}
                {message.isStreaming && (
                  <span className="inline-block w-2 h-4 ml-1 align-middle bg-zinc-400 animate-pulse" />
                )}
              </div>
            )}

            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={handleCopy} className="p-1 text-zinc-500 hover:text-white rounded bg-zinc-900/50 backdrop-blur-sm">
                    <Copy className="w-3 h-3" />
                </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default MessageBubble;
