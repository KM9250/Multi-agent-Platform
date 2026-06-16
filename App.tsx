import React, { useState, useEffect, useRef } from 'react';
import { Menu, Send, StopCircle, Trash2, BrainCircuit, Paperclip, X, FileText, Settings, Box, Gamepad2, AlertTriangle, MonitorPlay } from 'lucide-react';
import AgentSidebar from './components/AgentSidebar';
import AgentModal from './components/AgentModal';
import MessageBubble from './components/MessageBubble';
import RelationshipGraphModal from './components/RelationshipGraphModal';
import RoomModal from './components/RoomModal';
import SceneView from './components/SceneView';
import DecisionDiagnosticsPanel from './components/DecisionDiagnosticsPanel';
import { streamAgentResponse, evaluateShouldRespond, hasApiKey } from './services/geminiService';
import { INITIAL_ROOMS, createNewRoom, calculateRelationshipWeights, ROOM_TAGS } from './constants';
import { normalizePersistedRooms } from './utils/persistenceMigration';
import { appendDecisionEvents, createDecisionEvent, fixedDecision } from './utils/decisionDiagnostics';
import { Agent, Message, Room, Attachment, RoomTag, AgentDecisionEvent } from './types';

export default function App() {
  // --- State ---
  const [rooms, setRooms] = useState<Room[]>(() => {
    try {
      const saved = localStorage.getItem('rooms');
      if (!saved) return INITIAL_ROOMS;
      // A reload during generation persists isStreaming: true, which would
      // leave a forever-blinking cursor and "Thinking" badges. Clear it.
      const parsed: Room[] = JSON.parse(saved);
      return normalizePersistedRooms(parsed);
    } catch (e) {
      console.error('Failed to restore rooms from localStorage:', e);
      return INITIAL_ROOMS;
    }
  });

  const [activeRoomId, setActiveRoomId] = useState<string>(() => {
    const saved = localStorage.getItem('activeRoomId');
    // A stale id (e.g. the room was deleted in a previous session) would make
    // every room update silently miss, so validate it against the loaded rooms.
    if (saved && rooms.some(r => r.id === saved)) return saved;
    return rooms[0]?.id ?? '';
  });

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  
  // UI Toggles
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isAgentModalOpen, setIsAgentModalOpen] = useState(false);
  const [isGraphModalOpen, setIsGraphModalOpen] = useState(false);
  const [isRoomModalOpen, setIsRoomModalOpen] = useState(false);
  const [is3DMode, setIs3DMode] = useState(false); 
  
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [planningAgents, setPlanningAgents] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  
  const isGeneratingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Derived State
  const activeRoom = rooms.find(r => r.id === activeRoomId) || rooms[0];
  const messages = activeRoom?.messages || [];
  const agents = activeRoom?.agents || [];

  const generatingAgentIds = messages
    .filter(m => m.isStreaming && m.role === 'model' && m.agentId)
    .map(m => m.agentId!);

  const allThinkingAgentIds = [...new Set([...planningAgents, ...generatingAgentIds])];
  const currentSpeakingAgentId = generatingAgentIds.length > 0 ? generatingAgentIds[0] : null;

  // --- Effects ---
  useEffect(() => {
    try {
      localStorage.setItem('rooms', JSON.stringify(rooms));
    } catch (e) {
      // Base64 image attachments/avatars can exceed the ~5MB storage quota.
      // Keep the app running; the session simply won't survive a reload.
      console.error('Failed to persist rooms to localStorage:', e);
      setStorageWarning('Some data could not be saved locally. The current session will continue, but recent changes may be lost after reload.');
    }
  }, [rooms]);

  useEffect(() => {
    localStorage.setItem('activeRoomId', activeRoomId);
  }, [activeRoomId]);

  const scrollToBottom = () => {
    setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 100);
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, activeRoomId, planningAgents.length, is3DMode]);

  // --- File Handling ---
  const processFiles = (files: FileList | File[]) => {
    Array.from(files).forEach((file: File) => {
      const reader = new FileReader();
      if (file.type.startsWith('image/')) {
        reader.onload = (event) => {
          const result = event.target?.result as string;
          setAttachments(prev => [...prev, {
            id: crypto.randomUUID(),
            type: 'image',
            name: file.name,
            mimeType: file.type,
            data: result
          }]);
        };
        reader.readAsDataURL(file);
      } else {
        reader.onload = (event) => {
          const result = event.target?.result as string;
          setAttachments(prev => [...prev, {
            id: crypto.randomUUID(),
            type: 'text',
            name: file.name,
            mimeType: file.type || 'text/plain',
            data: result
          }]);
        };
        reader.readAsText(file);
      }
    });
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      processFiles(e.target.files);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (isGenerating) return;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (isGenerating) return;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  };

  const addDecisionEvents = (roomId: string, events: AgentDecisionEvent[]) => {
    if (events.length === 0) return;
    setRooms(prev => prev.map(r => r.id === roomId ? { ...appendDecisionEvents(r, events), updatedAt: Date.now() } : r));
  };

  const updateLocalHistory = (roomId: string, msgId: string, content: string, streaming: boolean, error: boolean = false, errorCode?: string, errorDetail?: string) => {
    setRooms(prev => prev.map(r => {
       if (r.id !== roomId) return r;
       return {
           ...r,
           messages: r.messages.map(m => m.id === msgId ? { ...m, content, isStreaming: streaming, error, errorCode, errorDetail } : m)
       };
    }));
  };

  // --- Conversation Loop ---
  const processConversationTurn = async (currentHistory: Message[], turnDepth: number, turnId: string, roomId: string) => {
    if (turnDepth >= 3 || !isGeneratingRef.current) {
        setIsGenerating(false);
        isGeneratingRef.current = false;
        return;
    }

    const activeAgents = agents.filter(a => a.isEnabled);
    if (activeAgents.length === 0) {
        setIsGenerating(false);
        isGeneratingRef.current = false;
        return;
    }

    // Without a key, the decision module silently returns IGNORE for every
    // agent and the user gets no feedback at all — surface the error instead.
    if (!hasApiKey()) {
        addDecisionEvents(roomId, activeAgents.map(agent => createDecisionEvent(turnId, agent, { outcome: 'ERROR', source: 'api_error', latencyMs: 0, decisionModel: 'none', errorCode: 'AUTH_ERROR', errorDetail: 'API key is missing.' })));
        const errMsg: Message = {
            id: crypto.randomUUID(),
            role: 'model',
            content: 'Authentication failed.',
            timestamp: Date.now(),
            turnId,
            error: true,
            errorCode: 'AUTH_ERROR',
            errorDetail: 'The API key is missing. Set GEMINI_API_KEY in .env.local and restart the dev server.'
        };
        setRooms(prev => prev.map(r => r.id === roomId ? { ...r, messages: [...currentHistory, errMsg], updatedAt: Date.now() } : r));
        setIsGenerating(false);
        isGeneratingRef.current = false;
        return;
    }

    setPlanningAgents(activeAgents.map(a => a.id));
    const relationshipWeights = calculateRelationshipWeights(rooms);

    const decisions = await Promise.all(activeAgents.map(async (agent) => {
        const lastMsg = currentHistory[currentHistory.length - 1];
        const normalize = (s: string) => s.toLowerCase().replace(/\s/g, '');
        const isMentioned = lastMsg.content ? normalize(lastMsg.content).includes(`@${normalize(agent.name)}`) : false;
        
        if (!isMentioned) {
          const recentHistory = currentHistory.slice(-8);
          // Fixed: changed 'agentId' to 'agent.id' to fix reference error
          const myCount = recentHistory.filter(m => m.agentId === agent.id).length;
          if (myCount >= 3) return { agent, decision: fixedDecision('IGNORE', 'turn_limit') };
        }
        if (isMentioned) return { agent, decision: fixedDecision('RESPOND', 'mentioned') };
        
        const decision = await evaluateShouldRespond(agent, currentHistory, activeRoom.systemInstruction, {
          agents,
          signal: abortControllerRef.current?.signal
        });
        return { agent, decision };
    }));
    
    const decisionEvents = decisions.map(d => createDecisionEvent(turnId, d.agent, d.decision));
    addDecisionEvents(roomId, decisionEvents);

    setPlanningAgents([]); 
    if (!isGeneratingRef.current) return;

    const respondingAgents = decisions.filter(d => d.decision.outcome === 'RESPOND').map(d => d.agent);
    if (respondingAgents.length === 0) {
        setIsGenerating(false);
        isGeneratingRef.current = false;
        return; 
    }

    const sortedAgents = respondingAgents.sort((a, b) => {
        let scoreA = 0;
        let scoreB = 0;
        const lastIdxA = currentHistory.map(m => m.agentId).lastIndexOf(a.id);
        const lastIdxB = currentHistory.map(m => m.agentId).lastIndexOf(b.id);
        scoreA += (lastIdxA === -1 ? 10 : currentHistory.length - lastIdxA) * 10;
        scoreB += (lastIdxB === -1 ? 10 : currentHistory.length - lastIdxB) * 10;
        return scoreB - scoreA;
    });

    const timestamp = Date.now();
    const agentMessageIds: Record<string, string> = {};
    const newAgentMessages: Message[] = sortedAgents.map((agent, idx) => {
      const msgId = crypto.randomUUID();
      agentMessageIds[agent.id] = msgId;
      return {
        id: msgId,
        role: 'model',
        content: '',
        agentId: agent.id,
        // Distinct timestamps keep ordering stable for sorting and the graph
        timestamp: timestamp + idx + 1,
        isStreaming: true,
        turnId
      };
    });

    let nextHistory = [...currentHistory, ...newAgentMessages];
    updateActiveRoom({ messages: nextHistory });

    const agentPromises = sortedAgents.map(agent => {
      return new Promise<void>((resolve) => {
        const msgId = agentMessageIds[agent.id];
        let accumulatedText = "";
        streamAgentResponse(
          agent,
          [...currentHistory],
          activeRoom.systemInstruction, 
          (chunk) => {
            if (!isGeneratingRef.current) return;
            accumulatedText += chunk;
            updateLocalHistory(roomId, msgId, accumulatedText, true);
          },
          () => {
            if (!abortControllerRef.current?.signal.aborted && accumulatedText.length === 0) {
              const message = 'Empty response from model.';
              updateLocalHistory(roomId, msgId, message, false, true, 'EMPTY_RESPONSE', 'The response stream completed without any text.');
              nextHistory = nextHistory.map(m => m.id === msgId ? { ...m, content: message, isStreaming: false, error: true, errorCode: 'EMPTY_RESPONSE', errorDetail: 'The response stream completed without any text.' } : m);
            } else {
              updateLocalHistory(roomId, msgId, accumulatedText, false);
              nextHistory = nextHistory.map(m => m.id === msgId
                ? { ...m, content: accumulatedText, isStreaming: false }
                : m);
            }
            resolve();
          },
          (errorInfo) => {
            updateLocalHistory(roomId, msgId, errorInfo.message, false, true, errorInfo.code, errorInfo.detail);
            nextHistory = nextHistory.map(m => m.id === msgId
              ? { ...m, content: errorInfo.message, isStreaming: false, error: true, errorCode: errorInfo.code, errorDetail: errorInfo.detail }
              : m);
            resolve();
          },
          {
            agents,
            signal: abortControllerRef.current?.signal
          }
        );
      });
    });

    await Promise.all(agentPromises);
    if (isGeneratingRef.current) {
        await new Promise(r => setTimeout(r, 500));
        await processConversationTurn(nextHistory, turnDepth + 1, turnId, roomId);
    }
  };

  // --- Handlers ---
  const handleSaveRoom = (title: string, description: string, type: RoomTag, systemInstruction: string) => {
    if (editingRoom) {
      setRooms(prev => prev.map(r => r.id === editingRoom.id ? { ...r, title, description, type, systemInstruction, updatedAt: Date.now() } : r));
      setEditingRoom(null);
    } else {
      const newRoom = createNewRoom(title, description, type, systemInstruction);
      setRooms(prev => [newRoom, ...prev]);
      setActiveRoomId(newRoom.id);
    }
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  };

  const handleSwitchRoom = (id: string) => {
    setActiveRoomId(id);
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  };

  const handleDeleteRoom = (id: string) => {
    if (rooms.length <= 1) return;
    if (confirm("Are you sure you want to delete this chat?")) {
        const newRooms = rooms.filter(r => r.id !== id);
        setRooms(newRooms);
        if (activeRoomId === id) setActiveRoomId(newRooms[0].id);
    }
  };

  const updateActiveRoom = (updates: Partial<Room>) => {
    setRooms(prev => prev.map(r => r.id === activeRoomId ? { ...r, ...updates, updatedAt: Date.now() } : r));
  };

  const handleSendMessage = async () => {
    if ((!input.trim() && attachments.length === 0) || isGenerating || !activeRoom) return;
    setIsGenerating(true);
    isGeneratingRef.current = true;
    abortControllerRef.current = new AbortController();
    const turnId = crypto.randomUUID();
    const roomId = activeRoom.id;
    const newUserMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: input,
      attachments: [...attachments],
      timestamp: Date.now(),
      turnId
    };
    const updatedMessages = [...messages, newUserMessage];
    updateActiveRoom({ messages: updatedMessages });
    setInput('');
    setAttachments([]);
    await processConversationTurn(updatedMessages, 0, turnId, roomId);
  };

  const handleStop = () => {
    // Cancels in-flight API requests; aborted streams finalize via onComplete
    abortControllerRef.current?.abort();
    setIsGenerating(false);
    isGeneratingRef.current = false;
    setPlanningAgents([]);
  };

  const handleClearChat = () => {
    if (confirm("Are you sure you want to clear the conversation for this room?")) {
        updateActiveRoom({ messages: [], decisionEvents: [] });
    }
  };

  const handleAgentToggle = (agentId: string) => {
    updateActiveRoom({ agents: agents.map(a => a.id === agentId ? { ...a, isEnabled: !a.isEnabled } : a) });
  };
  const handleAgentDelete = (agentId: string) => {
    if (confirm("Delete this agent from this room?")) {
      updateActiveRoom({ agents: agents.filter(a => a.id !== agentId) });
    }
  };
  const handleAgentSave = (agent: Agent) => {
    const updatedAgents = agents.some(a => a.id === agent.id) 
        ? agents.map(a => a.id === agent.id ? agent : a)
        : [...agents, agent];
    updateActiveRoom({ agents: updatedAgents });
    setEditingAgent(null);
  };

  if (!activeRoom) return null;

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-blue-500/30">
      <AgentSidebar 
        rooms={rooms}
        activeRoomId={activeRoomId}
        onSwitchRoom={handleSwitchRoom}
        onNewRoom={() => { setEditingRoom(null); setIsRoomModalOpen(true); }}
        onDeleteRoom={handleDeleteRoom}
        agents={agents}
        onToggleAgent={handleAgentToggle}
        onDeleteAgent={handleAgentDelete}
        onEditAgent={(a) => { setEditingAgent(a); setIsAgentModalOpen(true); }}
        onAddAgent={() => { setEditingAgent(null); setIsAgentModalOpen(true); }}
        thinkingAgentIds={allThinkingAgentIds}
        onShowGraph={() => setIsGraphModalOpen(true)}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
      />
      <div className="flex-1 flex flex-col h-full relative w-full transition-all duration-300">
        <header className="h-14 border-b border-zinc-800 flex items-center justify-between px-4 bg-zinc-950/80 backdrop-blur z-10 shrink-0">
          <div className="flex items-center gap-3">
            <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className="p-2 -ml-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors md:hidden">
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex flex-col">
                 <div className="flex items-center gap-2 group cursor-pointer" onClick={() => { setEditingRoom(activeRoom); setIsRoomModalOpen(true); }}>
                    <h1 className="font-bold text-sm md:text-lg tracking-tight bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent group-hover:text-blue-300 transition-colors">
                      {activeRoom.title}
                    </h1>
                    {activeRoom.type && (
                      <span className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-md ${ROOM_TAGS.find(t => t.value === activeRoom.type)?.color || 'text-zinc-500'}`}>
                        {activeRoom.type === 'Sandbox' && <Box className="w-3 h-3" />}
                        {activeRoom.type === 'Recreation' && <Gamepad2 className="w-3 h-3" />}
                        {activeRoom.type === 'Hard' && <AlertTriangle className="w-3 h-3" />}
                        {activeRoom.type}
                      </span>
                    )}
                    <Settings className="w-3.5 h-3.5 text-zinc-600 group-hover:text-zinc-400 transition-colors opacity-0 group-hover:opacity-100" />
                 </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
             <button onClick={() => setIs3DMode(!is3DMode)} className={`p-2 rounded-lg transition-colors border ${is3DMode ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' : 'text-zinc-400 hover:bg-zinc-800 border-transparent'}`} title="Toggle 3D View">
                <MonitorPlay className="w-4 h-4" />
             </button>
             {messages.length > 0 && (
                <button onClick={handleClearChat} className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-red-400 transition-colors" title="Clear Chat">
                  <Trash2 className="w-4 h-4" />
                </button>
             )}
          </div>
        </header>
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {storageWarning && (
            <div className="mx-4 mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200 flex items-center justify-between gap-3">
              <span>{storageWarning}</span>
              <button onClick={() => setStorageWarning(null)} className="text-amber-100 hover:text-white"><X className="w-4 h-4" /></button>
            </div>
          )}
          <DecisionDiagnosticsPanel events={activeRoom.decisionEvents || []} />
          {is3DMode && (
            <div className="h-1/2 min-h-[300px] border-b border-zinc-800 relative animate-in fade-in slide-in-from-top-4 duration-300">
               <SceneView agents={agents} speakingAgentId={currentSpeakingAgentId} />
            </div>
          )}
          <div className={`flex-1 flex flex-col min-h-0 relative ${is3DMode ? 'h-1/2' : 'h-full'}`}>
            <div className="flex-1 overflow-y-auto p-4 md:p-6 scroll-smooth">
              <div className="max-w-4xl mx-auto min-h-full flex flex-col">
                {messages.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 space-y-4 pb-20 opacity-50">
                      <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-4xl mb-2">⚡</div>
                      <p className="text-sm font-medium text-zinc-400">Welcome to {activeRoom.title}</p>
                  </div>
                ) : (
                  messages.map(msg => (
                    <MessageBubble 
                      key={msg.id} 
                      message={msg} 
                      agent={msg.role === 'model' && msg.agentId ? agents.find(a => a.id === msg.agentId) : undefined} 
                    />
                  ))
                )}
                {planningAgents.length > 0 && (
                    <div className="flex flex-col gap-2 items-start ml-4 mb-6 mt-2 animate-in fade-in duration-300">
                        <div className="flex items-center gap-2 text-xs text-zinc-400 font-medium bg-zinc-900/50 px-3 py-1.5 rounded-full border border-zinc-800">
                          <BrainCircuit className="w-3.5 h-3.5 text-purple-400" /> Deciding...
                        </div>
                    </div>
                )}
                <div ref={messagesEndRef} className="h-4" />
              </div>
            </div>
            <div className="p-4 border-t border-zinc-800 bg-zinc-950 shrink-0">
              <div className={`max-w-4xl mx-auto relative bg-zinc-900 border rounded-xl transition-all duration-200 ${isDragging ? 'border-blue-500 bg-zinc-800' : 'border-zinc-800'}`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
                {attachments.length > 0 && (
                  <div className="flex gap-2 p-3 pb-0 overflow-x-auto">
                    {attachments.map(att => (
                      <div key={att.id} className="relative group shrink-0 w-20 h-20 bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden flex items-center justify-center">
                        {att.type === 'image' ? <img src={att.data} className="w-full h-full object-cover" /> : <FileText className="w-8 h-8 text-zinc-500" />}
                        <button onClick={() => removeAttachment(att.id)} className="absolute top-1 right-1 p-0.5 bg-black/60 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"><X className="w-3.5 h-3.5" /></button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-end">
                    <div className="p-2">
                      <input type="file" multiple ref={fileInputRef} className="hidden" onChange={handleFileSelect}/>
                      <button onClick={() => fileInputRef.current?.click()} className="p-2 text-zinc-400 hover:text-white rounded-lg" disabled={isGenerating}><Paperclip className="w-5 h-5" /></button>
                    </div>
                    <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }} placeholder={`Message ${activeRoom.title}...`} className="w-full bg-transparent border-0 text-zinc-100 px-2 py-3.5 focus:outline-none resize-none min-h-[50px] max-h-32" rows={1} disabled={isGenerating}/>
                    <div className="p-2">
                        <button onClick={isGenerating ? handleStop : handleSendMessage} disabled={(!input.trim() && attachments.length === 0) && !isGenerating} className={`p-2 rounded-lg ${(input.trim() || attachments.length > 0 || isGenerating) ? 'bg-white text-black' : 'bg-zinc-800 text-zinc-500'}`}>
                          {isGenerating ? <StopCircle className="w-5 h-5 animate-pulse text-red-500" /> : <Send className="w-5 h-5" />}
                        </button>
                    </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <AgentModal isOpen={isAgentModalOpen} onClose={() => setIsAgentModalOpen(false)} onSave={handleAgentSave} editingAgent={editingAgent}/>
      <RoomModal isOpen={isRoomModalOpen} onClose={() => setIsRoomModalOpen(false)} onSave={handleSaveRoom} editingRoom={editingRoom}/>
      <RelationshipGraphModal isOpen={isGraphModalOpen} onClose={() => setIsGraphModalOpen(false)} rooms={rooms}/>
    </div>
  );
}
