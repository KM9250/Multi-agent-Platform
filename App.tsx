
import React, { useState, useEffect, useRef } from 'react';
import { Menu, Send, StopCircle, Trash2, BrainCircuit, Paperclip, X, FileText, Image as ImageIcon, Upload, Settings, Box, Gamepad2, AlertTriangle, Cuboid, MonitorPlay } from 'lucide-react';
import AgentSidebar from './components/AgentSidebar';
import AgentModal from './components/AgentModal';
import MessageBubble from './components/MessageBubble';
import RelationshipGraphModal from './components/RelationshipGraphModal';
import RoomModal from './components/RoomModal';
import SceneView from './components/SceneView';
import { streamAgentResponse, evaluateShouldRespond } from './services/geminiService';
import { INITIAL_ROOMS, createNewRoom, calculateRelationshipWeights, ROOM_TAGS } from './constants';
import { Agent, Message, Room, Attachment, RoomTag } from './types';

export default function App() {
  // --- State ---
  const [rooms, setRooms] = useState<Room[]>(() => {
    const saved = localStorage.getItem('rooms');
    return saved ? JSON.parse(saved) : INITIAL_ROOMS;
  });

  const [activeRoomId, setActiveRoomId] = useState<string>(() => {
    const saved = localStorage.getItem('activeRoomId');
    return saved || (rooms[0]?.id ?? '');
  });

  const [input, setInput] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  
  // UI Toggles
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isAgentModalOpen, setIsAgentModalOpen] = useState(false);
  const [isGraphModalOpen, setIsGraphModalOpen] = useState(false);
  const [isRoomModalOpen, setIsRoomModalOpen] = useState(false);
  const [is3DMode, setIs3DMode] = useState(false); // New: 3D Mode Toggle
  
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  
  const [isGenerating, setIsGenerating] = useState(false);
  const [planningAgents, setPlanningAgents] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  
  const isGeneratingRef = useRef(false);
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

  // Determine currently speaking agent for the 3D view
  const currentSpeakingAgentId = generatingAgentIds.length > 0 ? generatingAgentIds[0] : null;

  // --- Effects ---
  useEffect(() => {
    localStorage.setItem('rooms', JSON.stringify(rooms));
  }, [rooms]);

  useEffect(() => {
    localStorage.setItem('activeRoomId', activeRoomId);
  }, [activeRoomId]);

  const scrollToBottom = () => {
    // Small delay to allow layout to adjust
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
      
      // Check if image
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
        // Assume text/code for others
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
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (isGenerating) return;
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    // Prevent flickering when dragging over child elements
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

  // --- Logic Helpers ---

  const checkMention = (content: string, agentName: string) => {
    const normalize = (s: string) => s.toLowerCase().replace(/\s/g, '');
    const normalizedContent = normalize(content);
    const normalizedName = normalize(agentName);
    return normalizedContent.includes(`@${normalizedName}`);
  };

  const checkTurnLimits = (agentId: string, history: Message[]) => {
    const lastMsg = history[history.length - 1];
    if (lastMsg?.role === 'model' && lastMsg?.agentId === agentId) {
        return false;
    }
    const recentHistory = history.slice(-8);
    const myCount = recentHistory.filter(m => m.agentId === agentId).length;
    if (myCount >= 3) return false;
    return true;
  };

  const calculatePriority = (agentId: string, history: Message[], weights: Map<string, number>) => {
      let score = 0;
      const lastIndex = history.map(m => m.agentId).lastIndexOf(agentId);
      const turnsSinceLast = lastIndex === -1 ? 10 : (history.length - lastIndex);
      score += turnsSinceLast * 10;
      const lastMsg = history[history.length - 1];
      const sourceId = lastMsg.role === 'user' ? 'user' : (lastMsg.agentId || 'unknown');
      const key = `${sourceId}->${agentId}`;
      const weight = weights.get(key) || 0;
      score += weight;
      return score;
  };

  // --- Conversation Loop ---

  const processConversationTurn = async (currentHistory: Message[], turnDepth: number) => {
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

    setPlanningAgents(activeAgents.map(a => a.id));
    const relationshipWeights = calculateRelationshipWeights(rooms);

    const decisions = await Promise.all(activeAgents.map(async (agent) => {
        const lastMsg = currentHistory[currentHistory.length - 1];
        const isMentioned = lastMsg.content ? checkMention(lastMsg.content, agent.name) : false;
        
        if (!isMentioned && !checkTurnLimits(agent.id, currentHistory)) {
            return { agent, shouldRespond: false, reason: 'turn_limit' };
        }
        if (isMentioned) {
             return { agent, shouldRespond: true, reason: 'mentioned' };
        }
        const shouldRespond = await evaluateShouldRespond(agent, currentHistory, activeRoom.systemInstruction);
        return { agent, shouldRespond, reason: 'llm_decision' };
    }));
    
    setPlanningAgents([]); 

    if (!isGeneratingRef.current) return;

    const respondingAgents = decisions
        .filter(d => d.shouldRespond)
        .map(d => d.agent);

    if (respondingAgents.length === 0) {
        setIsGenerating(false);
        isGeneratingRef.current = false;
        return; 
    }

    const sortedAgents = respondingAgents.sort((a, b) => {
        const scoreA = calculatePriority(a.id, currentHistory, relationshipWeights);
        const scoreB = calculatePriority(b.id, currentHistory, relationshipWeights);
        return scoreB - scoreA;
    });

    const timestamp = Date.now();
    const agentMessageIds: Record<string, string> = {};
    const newAgentMessages: Message[] = sortedAgents.map(agent => {
      const msgId = crypto.randomUUID();
      agentMessageIds[agent.id] = msgId;
      return {
        id: msgId,
        role: 'model',
        content: '',
        agentId: agent.id,
        timestamp: timestamp + 1,
        isStreaming: true
      };
    });

    let nextHistory = [...currentHistory, ...newAgentMessages];
    const updateLocalHistory = (msgId: string, content: string, streaming: boolean, error: boolean = false) => {
         setRooms(prev => prev.map(r => {
            if (r.id !== activeRoomId) return r;
            return {
                ...r,
                messages: r.messages.map(m => m.id === msgId ? { ...m, content, isStreaming: streaming, error } : m)
            };
        }));
    };

    // Note: We need to push the initial placeholders to state
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
            updateLocalHistory(msgId, accumulatedText, true);
          },
          () => {
            updateLocalHistory(msgId, accumulatedText, false);
            const targetMsg = nextHistory.find(m => m.id === msgId);
            if (targetMsg) targetMsg.content = accumulatedText;
            resolve();
          },
          (error) => {
            updateLocalHistory(msgId, error.message, false, true);
            resolve();
          }
        );
      });
    });

    await Promise.all(agentPromises);

    if (isGeneratingRef.current) {
        await new Promise(r => setTimeout(r, 500));
        await processConversationTurn(nextHistory, turnDepth + 1);
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
    if (rooms.length <= 1) {
        alert("Cannot delete the last room.");
        return;
    }
    if (confirm("Are you sure you want to delete this chat?")) {
        const newRooms = rooms.filter(r => r.id !== id);
        setRooms(newRooms);
        if (activeRoomId === id) {
            setActiveRoomId(newRooms[0].id);
        }
    }
  };

  const updateActiveRoom = (updates: Partial<Room>) => {
    setRooms(prev => prev.map(r => r.id === activeRoomId ? { ...r, ...updates, updatedAt: Date.now() } : r));
  };

  const handleSendMessage = async () => {
    if ((!input.trim() && attachments.length === 0) || isGenerating || !activeRoom) return;

    setIsGenerating(true);
    isGeneratingRef.current = true;

    const userMsgId = crypto.randomUUID();
    const newUserMessage: Message = {
      id: userMsgId,
      role: 'user',
      content: input,
      attachments: [...attachments], // Copy current attachments
      timestamp: Date.now()
    };

    const updatedMessages = [...messages, newUserMessage];
    updateActiveRoom({ messages: updatedMessages });
    
    setInput('');
    setAttachments([]); // Clear attachments after sending

    await processConversationTurn(updatedMessages, 0);
  };

  const handleStop = () => {
    setIsGenerating(false);
    isGeneratingRef.current = false;
    setPlanningAgents([]);
  };

  const handleClearChat = () => {
    if (confirm("Are you sure you want to clear the conversation for this room?")) {
        updateActiveRoom({ messages: [] });
    }
  };

  // Agent State Handlers
  const handleAgentToggle = (agentId: string) => {
    const updatedAgents = agents.map(a => a.id === agentId ? { ...a, isEnabled: !a.isEnabled } : a);
    updateActiveRoom({ agents: updatedAgents });
  };
  const handleAgentDelete = (agentId: string) => {
    if (confirm("Delete this agent from this room?")) {
      const updatedAgents = agents.filter(a => a.id !== agentId);
      updateActiveRoom({ agents: updatedAgents });
    }
  };
  const handleAgentSave = (agent: Agent) => {
    let updatedAgents;
    if (agents.some(a => a.id === agent.id)) {
        updatedAgents = agents.map(a => a.id === agent.id ? agent : a);
    } else {
        updatedAgents = [...agents, agent];
    }
    updateActiveRoom({ agents: updatedAgents });
    setEditingAgent(null);
  };

  const getTagColor = (tagName: string) => {
    const tag = ROOM_TAGS.find(t => t.value === tagName);
    return tag ? tag.color : 'text-zinc-500';
  };

  const getTagIcon = (type: RoomTag) => {
    switch (type) {
      case 'Sandbox': return <Box className="w-3 h-3" />;
      case 'Recreation': return <Gamepad2 className="w-3 h-3" />;
      case 'Hard': return <AlertTriangle className="w-3 h-3" />;
      default: return null;
    }
  };

  if (!activeRoom) return <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-500">Loading...</div>;

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
            <button 
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="p-2 -ml-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors md:hidden"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex flex-col">
                 <div className="flex items-center gap-2 group cursor-pointer" onClick={() => { setEditingRoom(activeRoom); setIsRoomModalOpen(true); }}>
                    <h1 className="font-bold text-sm md:text-lg tracking-tight bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent group-hover:text-blue-300 transition-colors">
                      {activeRoom.title}
                    </h1>
                    {activeRoom.type && (
                      <span className={`inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-md ${getTagColor(activeRoom.type)}`}>
                        {getTagIcon(activeRoom.type)}
                        {activeRoom.type}
                      </span>
                    )}
                    <Settings className="w-3.5 h-3.5 text-zinc-600 group-hover:text-zinc-400 transition-colors opacity-0 group-hover:opacity-100" />
                 </div>
                <span className="text-[10px] text-zinc-500 hidden md:block">
                    {agents.filter(a => a.isEnabled).length} Agents Active
                </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            
             {/* 3D Mode Toggle */}
             <button
               onClick={() => setIs3DMode(!is3DMode)}
               className={`p-2 rounded-lg transition-colors border ${is3DMode ? 'bg-blue-500/10 text-blue-400 border-blue-500/30' : 'text-zinc-400 hover:bg-zinc-800 border-transparent'}`}
               title="Toggle 3D Scene View"
             >
                <MonitorPlay className="w-4 h-4" />
             </button>

             {messages.length > 0 && (
                <button 
                  onClick={handleClearChat}
                  className="p-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-red-400 transition-colors"
                  title="Clear Messages"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
             )}
          </div>
        </header>

        {/* Layout Split Container */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          
          {/* Top Half: 3D Scene View (Only visible if is3DMode is true) */}
          {is3DMode && (
            <div className="h-1/2 min-h-[300px] border-b border-zinc-800 relative animate-in fade-in slide-in-from-top-4 duration-300">
               <SceneView agents={agents} speakingAgentId={currentSpeakingAgentId} />
            </div>
          )}

          {/* Bottom Half: Chat Area */}
          <div className={`flex-1 flex flex-col min-h-0 relative ${is3DMode ? 'h-1/2' : 'h-full'}`}>
            <div className="flex-1 overflow-y-auto p-4 md:p-6 scroll-smooth">
              <div className="max-w-4xl mx-auto min-h-full flex flex-col">
                
                {messages.length === 0 ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 space-y-4 pb-20 opacity-50">
                      <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-4xl mb-2">
                        ⚡
                      </div>
                      <p className="text-sm font-medium text-zinc-400">Welcome to {activeRoom.title}</p>
                      <p className="text-xs max-w-sm text-center">{activeRoom.description || "Start the conversation by sending a message below."}</p>
                      {activeRoom.systemInstruction && (
                          <div className="text-[10px] text-zinc-500 max-w-xs text-center border border-zinc-800 rounded p-2 bg-zinc-900/50">
                            <span className="font-semibold block mb-1">Shared Rules:</span>
                            {activeRoom.systemInstruction.slice(0, 100)}{activeRoom.systemInstruction.length > 100 ? '...' : ''}
                          </div>
                      )}
                  </div>
                ) : (
                  messages.map(msg => {
                    const agent = msg.role === 'model' && msg.agentId 
                      ? agents.find(a => a.id === msg.agentId) 
                      : undefined;
                    return (
                      <MessageBubble 
                        key={msg.id} 
                        message={msg} 
                        agent={agent} 
                      />
                    );
                  })
                )}
                
                {/* Planning/Thinking Indicator */}
                {planningAgents.length > 0 && (
                    <div className="flex flex-col gap-2 items-start ml-4 mb-6 mt-2 animate-in fade-in duration-300">
                        <div className="flex items-center gap-2 text-xs text-zinc-400 font-medium bg-zinc-900/50 px-3 py-1.5 rounded-full border border-zinc-800">
                          <BrainCircuit className="w-3.5 h-3.5 text-purple-400" />
                          Deciding who should respond...
                        </div>
                        <div className="flex items-center gap-[-0.5rem] pl-2">
                          {planningAgents.map(id => {
                            const agent = agents.find(a => a.id === id);
                            if (!agent) return null;
                            return (
                              <div key={id} className="relative -ml-2 first:ml-0 group">
                                  <div className={`
                                    w-8 h-8 rounded-full border-2 border-zinc-950 flex items-center justify-center text-sm shadow-sm overflow-hidden bg-zinc-800 relative z-0
                                    ring-2 ring-purple-500/50 animate-pulse
                                    ${agent.avatarType === 'image' ? '' : agent.color}
                                  `}>
                                    {agent.avatarType === 'image' ? (
                                        <img src={agent.avatar} alt={agent.name} className="w-full h-full object-cover" />
                                    ) : (
                                        agent.avatar
                                    )}
                                  </div>
                              </div>
                            );
                          })}
                        </div>
                    </div>
                )}

                <div ref={messagesEndRef} className="h-4" />
              </div>
            </div>

            <div className="p-4 border-t border-zinc-800 bg-zinc-950 shrink-0">
              <div 
                className={`max-w-4xl mx-auto relative bg-zinc-900 border rounded-xl overflow-hidden transition-all duration-200
                  ${isDragging 
                    ? 'border-blue-500 ring-2 ring-blue-500/20 bg-zinc-800' 
                    : 'border-zinc-800 focus-within:ring-2 focus-within:ring-zinc-700'
                  }
                `}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                {/* Drag Overlay */}
                {isDragging && (
                    <div className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-900/90 backdrop-blur-sm m-1 rounded-lg border-2 border-dashed border-blue-500/50">
                      <div className="text-blue-400 flex flex-col items-center gap-2 animate-in fade-in zoom-in-95 duration-200">
                          <Upload className="w-10 h-10 animate-bounce" />
                          <span className="font-medium text-lg">Drop files to attach</span>
                      </div>
                    </div>
                )}
                
                {/* Attachment Previews */}
                {attachments.length > 0 && (
                  <div className="flex gap-2 p-3 pb-0 overflow-x-auto custom-scrollbar">
                    {attachments.map(att => (
                      <div key={att.id} className="relative group shrink-0 w-20 h-20 bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden flex items-center justify-center">
                        {att.type === 'image' ? (
                          <img src={att.data} alt={att.name} className="w-full h-full object-cover" />
                        ) : (
                          <FileText className="w-8 h-8 text-zinc-500" />
                        )}
                        <button 
                          onClick={() => removeAttachment(att.id)}
                          className="absolute top-1 right-1 p-0.5 bg-black/60 rounded-full text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                        <span className="absolute bottom-0 inset-x-0 text-[9px] bg-black/60 text-white truncate px-1 py-0.5 text-center">
                          {att.name}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex items-end">
                    <div className="p-2">
                      <input 
                        type="file" 
                        multiple 
                        ref={fileInputRef}
                        className="hidden" 
                        onChange={handleFileSelect}
                      />
                      <button 
                        onClick={() => fileInputRef.current?.click()}
                        className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors"
                        title="Attach file"
                        disabled={isGenerating}
                      >
                        <Paperclip className="w-5 h-5" />
                      </button>
                    </div>

                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendMessage();
                        }
                      }}
                      placeholder={`Message ${activeRoom.title}...`}
                      className="w-full bg-transparent border-0 text-zinc-100 px-2 py-3.5 focus:outline-none focus:ring-0 resize-none min-h-[50px] max-h-32"
                      rows={1}
                      disabled={isGenerating}
                    />

                    <div className="p-2">
                        <button
                          onClick={isGenerating ? handleStop : handleSendMessage}
                          disabled={(!input.trim() && attachments.length === 0) && !isGenerating}
                          className={`
                            p-2 rounded-lg transition-all duration-200
                            ${(input.trim() || attachments.length > 0 || isGenerating)
                              ? 'bg-white text-black hover:bg-zinc-200' 
                              : 'bg-zinc-800 text-zinc-500 cursor-not-allowed'}
                          `}
                        >
                          {isGenerating ? (
                            <StopCircle className="w-5 h-5 animate-pulse text-red-500" />
                          ) : (
                            <Send className="w-5 h-5" />
                          )}
                        </button>
                    </div>
                </div>
              </div>
              <div className="text-center mt-2">
                  <p className="text-[10px] text-zinc-600">
                      AI responses may be inaccurate. Verify important information.
                  </p>
              </div>
            </div>
          </div>

        </div>

      </div>

      <AgentModal 
        isOpen={isAgentModalOpen}
        onClose={() => setIsAgentModalOpen(false)}
        onSave={handleAgentSave}
        editingAgent={editingAgent}
      />

      <RoomModal 
        isOpen={isRoomModalOpen}
        onClose={() => setIsRoomModalOpen(false)}
        onSave={handleSaveRoom}
        editingRoom={editingRoom}
      />

      <RelationshipGraphModal 
        isOpen={isGraphModalOpen}
        onClose={() => setIsGraphModalOpen(false)}
        rooms={rooms}
      />
    </div>
  );
}
