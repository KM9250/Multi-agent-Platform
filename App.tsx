import React, { useState, useEffect, useRef } from 'react';
import { Menu, Send, StopCircle, Trash2, BrainCircuit } from 'lucide-react';
import AgentSidebar from './components/AgentSidebar';
import AgentModal from './components/AgentModal';
import MessageBubble from './components/MessageBubble';
import RelationshipGraphModal from './components/RelationshipGraphModal';
import { streamAgentResponse, evaluateShouldRespond } from './services/geminiService';
import { INITIAL_ROOMS, createNewRoom, calculateRelationshipWeights } from './constants';
import { Agent, Message, Room } from './types';

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
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  
  // Modals
  const [isAgentModalOpen, setIsAgentModalOpen] = useState(false);
  const [isGraphModalOpen, setIsGraphModalOpen] = useState(false);
  
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  
  // Generation Status
  const [isGenerating, setIsGenerating] = useState(false);
  const [planningAgents, setPlanningAgents] = useState<string[]>([]); // Agents currently "thinking" about whether to reply
  
  // Refs for control
  const isGeneratingRef = useRef(false); // Ref to track status inside async loops
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Derived State
  const activeRoom = rooms.find(r => r.id === activeRoomId) || rooms[0];
  const messages = activeRoom?.messages || [];
  const agents = activeRoom?.agents || [];

  // Identify agents that are currently generating (streaming a response)
  const generatingAgentIds = messages
    .filter(m => m.isStreaming && m.role === 'model' && m.agentId)
    .map(m => m.agentId!);

  // Combined "Thinking" state for sidebar (Planning OR Generating)
  const allThinkingAgentIds = [...new Set([...planningAgents, ...generatingAgentIds])];

  // --- Effects ---
  useEffect(() => {
    localStorage.setItem('rooms', JSON.stringify(rooms));
  }, [rooms]);

  useEffect(() => {
    localStorage.setItem('activeRoomId', activeRoomId);
  }, [activeRoomId]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages.length, activeRoomId, planningAgents.length]);

  // --- Room Handlers ---
  
  const handleNewRoom = () => {
    const newRoom = createNewRoom();
    setRooms(prev => [newRoom, ...prev]);
    setActiveRoomId(newRoom.id);
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

  // --- Logic Helpers ---

  const checkMention = (content: string, agentName: string) => {
    const normalize = (s: string) => s.toLowerCase().replace(/\s/g, '');
    const normalizedContent = normalize(content);
    const normalizedName = normalize(agentName);
    return normalizedContent.includes(`@${normalizedName}`);
  };

  const checkTurnLimits = (agentId: string, history: Message[]) => {
    // 1. Don't reply if you were the absolute last person to speak (prevent self-reply loops)
    const lastMsg = history[history.length - 1];
    if (lastMsg?.role === 'model' && lastMsg?.agentId === agentId) {
        return false;
    }

    // 2. Max 3 replies in the last 8 messages (Slightly relaxed to allow debates)
    const recentHistory = history.slice(-8);
    const myCount = recentHistory.filter(m => m.agentId === agentId).length;
    if (myCount >= 3) return false;

    return true;
  };

  const calculatePriority = (agentId: string, history: Message[], weights: Map<string, number>) => {
      let score = 0;
      
      // 1. Recency Score (Higher if haven't spoken in a while)
      const lastIndex = history.map(m => m.agentId).lastIndexOf(agentId);
      const turnsSinceLast = lastIndex === -1 ? 10 : (history.length - lastIndex);
      score += turnsSinceLast * 10;

      // 2. Relationship Score (User -> Agent)
      const lastMsg = history[history.length - 1];
      const sourceId = lastMsg.role === 'user' ? 'user' : (lastMsg.agentId || 'unknown');
      const key = `${sourceId}->${agentId}`;
      const weight = weights.get(key) || 0;
      
      score += weight;

      return score;
  };

  // --- Core Conversation Loop ---

  const processConversationTurn = async (currentHistory: Message[], turnDepth: number) => {
    // Safety Break: Max 3 auto-turns or manual stop
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

    // --- 1. Filter & Decision Phase ---
    setPlanningAgents(activeAgents.map(a => a.id));

    // Calculate global relationship weights once for priority logic
    // Note: We need to calculate this based on GLOBAL state, but mainly focusing on this room's context
    // Ideally we pass `rooms` but `currentHistory` is the "future" state of this room.
    // We'll stick to the global `rooms` for historical weights, assuming latest message impact is minor for this decision.
    const relationshipWeights = calculateRelationshipWeights(rooms);

    const decisions = await Promise.all(activeAgents.map(async (agent) => {
        const lastMsg = currentHistory[currentHistory.length - 1];
        
        // A. Check Mentions (Override everything)
        // Only check mention if the LAST message mentioned me. 
        // We don't want to reply to a mention 5 turns ago again.
        const isMentioned = lastMsg.content ? checkMention(lastMsg.content, agent.name) : false;
        
        // B. Check Hard Limits (Turn Constraints)
        if (!isMentioned && !checkTurnLimits(agent.id, currentHistory)) {
            return { agent, shouldRespond: false, reason: 'turn_limit' };
        }

        // C. LLM Decision (Soft Filter)
        if (isMentioned) {
             return { agent, shouldRespond: true, reason: 'mentioned' };
        }

        const shouldRespond = await evaluateShouldRespond(agent, currentHistory);
        return { agent, shouldRespond, reason: 'llm_decision' };
    }));
    
    setPlanningAgents([]); 

    if (!isGeneratingRef.current) return; // Stopped while thinking

    const respondingAgents = decisions
        .filter(d => d.shouldRespond)
        .map(d => d.agent);

    if (respondingAgents.length === 0) {
        // No one wants to talk. Conversation loop ends naturally.
        setIsGenerating(false);
        isGeneratingRef.current = false;
        return; 
    }

    // --- 2. Priority Sort ---
    const sortedAgents = respondingAgents.sort((a, b) => {
        const scoreA = calculatePriority(a.id, currentHistory, relationshipWeights);
        const scoreB = calculatePriority(b.id, currentHistory, relationshipWeights);
        return scoreB - scoreA;
    });

    // --- 3. Execution Phase ---
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

    // Update UI with placeholders
    let nextHistory = [...currentHistory, ...newAgentMessages];
    updateActiveRoom({ messages: nextHistory });

    // Stream responses
    const agentPromises = sortedAgents.map(agent => {
      return new Promise<void>((resolve) => {
        const msgId = agentMessageIds[agent.id];
        let accumulatedText = "";

        streamAgentResponse(
          agent,
          [...currentHistory], // They see history BEFORE they started speaking
          (chunk) => {
            if (!isGeneratingRef.current) return;
            accumulatedText += chunk;
            setRooms(prev => prev.map(r => {
                if (r.id !== activeRoomId) return r;
                return {
                    ...r,
                    messages: r.messages.map(m => m.id === msgId ? { ...m, content: accumulatedText } : m)
                };
            }));
          },
          () => {
             setRooms(prev => prev.map(r => {
                if (r.id !== activeRoomId) return r;
                return {
                    ...r,
                    messages: r.messages.map(m => m.id === msgId ? { ...m, isStreaming: false } : m)
                };
            }));
            // Update the local history object for the next recursion
            const targetMsg = nextHistory.find(m => m.id === msgId);
            if (targetMsg) targetMsg.content = accumulatedText;
            resolve();
          },
          (error) => {
             setRooms(prev => prev.map(r => {
                if (r.id !== activeRoomId) return r;
                return {
                    ...r,
                    messages: r.messages.map(m => m.id === msgId ? { ...m, isStreaming: false, error: true, content: error.message } : m)
                };
            }));
            resolve();
          }
        );
      });
    });

    await Promise.all(agentPromises);

    // --- 4. Recursion ---
    if (isGeneratingRef.current) {
        // Wait a small moment for natural pacing?
        await new Promise(r => setTimeout(r, 500));
        // Pass the updated history (with filled content) to next turn
        await processConversationTurn(nextHistory, turnDepth + 1);
    }
  };

  const handleSendMessage = async () => {
    if (!input.trim() || isGenerating || !activeRoom) return;

    // Start Generation
    setIsGenerating(true);
    isGeneratingRef.current = true;

    const userMsgId = crypto.randomUUID();
    const userContent = input;
    const newUserMessage: Message = {
      id: userMsgId,
      role: 'user',
      content: userContent,
      timestamp: Date.now()
    };

    let newTitle = activeRoom.title;
    if (activeRoom.messages.length === 0 && activeRoom.title === 'New Chat') {
         newTitle = userContent.slice(0, 30) + (userContent.length > 30 ? '...' : '');
    }

    const updatedMessages = [...messages, newUserMessage];
    updateActiveRoom({ messages: updatedMessages, title: newTitle });
    setInput('');

    // Kick off the conversation loop
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

  // --- Agent Handlers ---
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

  // --- UI ---
  const openEditModal = (agent: Agent) => {
    setEditingAgent(agent);
    setIsAgentModalOpen(true);
  };

  const openCreateModal = () => {
    setEditingAgent(null);
    setIsAgentModalOpen(true);
  };

  if (!activeRoom) return <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-500">Loading...</div>;

  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-blue-500/30">
      
      <AgentSidebar 
        rooms={rooms}
        activeRoomId={activeRoomId}
        onSwitchRoom={handleSwitchRoom}
        onNewRoom={handleNewRoom}
        onDeleteRoom={handleDeleteRoom}
        agents={agents}
        onToggleAgent={handleAgentToggle}
        onDeleteAgent={handleAgentDelete}
        onEditAgent={openEditModal}
        onAddAgent={openCreateModal}
        thinkingAgentIds={allThinkingAgentIds}
        onShowGraph={() => setIsGraphModalOpen(true)}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
      />

      <div className="flex-1 flex flex-col h-full relative w-full transition-all">
        
        <header className="h-14 border-b border-zinc-800 flex items-center justify-between px-4 bg-zinc-950/80 backdrop-blur z-10 shrink-0">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
              className="p-2 -ml-2 hover:bg-zinc-800 rounded-lg text-zinc-400 hover:text-white transition-colors md:hidden"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="flex flex-col">
                 <h1 className="font-bold text-sm md:text-lg tracking-tight bg-gradient-to-r from-white to-zinc-400 bg-clip-text text-transparent">
                  {activeRoom.title}
                </h1>
                <span className="text-[10px] text-zinc-500 hidden md:block">
                    {agents.filter(a => a.isEnabled).length} Agents Active
                </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
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

        {/* Chat Area */}
        <div className="flex-1 overflow-y-auto p-4 md:p-6 scroll-smooth">
          <div className="max-w-4xl mx-auto min-h-full flex flex-col">
            
            {messages.length === 0 ? (
               <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 space-y-4 pb-20 opacity-50">
                  <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-4xl mb-2">
                    ⚡
                  </div>
                  <p className="text-sm">Configure your agents in the sidebar and start a conversation.</p>
               </div>
            ) : (
              messages.map(msg => {
                const agent = msg.role === 'model' && msg.agentId 
                  ? agents.find(a => a.id === msg.agentId) 
                  : undefined;
                
                const displayAgent = agent || (msg.role === 'model' ? {
                   name: 'Unknown Agent', 
                   color: 'bg-zinc-700', 
                   avatar: '?',
                   id: 'unknown',
                   isEnabled: false,
                   description: '',
                   systemInstruction: '',
                   model: '',
                   thinkingBudget: 0
                } : undefined);

                return (
                  <MessageBubble 
                    key={msg.id} 
                    message={msg} 
                    agent={displayAgent} 
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
                              <div className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black text-[10px] text-white px-2 py-0.5 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10 pointer-events-none">
                                {agent.name}
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
          <div className="max-w-4xl mx-auto relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder={`Message ${activeRoom.title} (Use @Name to mention)...`}
              className="w-full bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-xl pl-4 pr-12 py-3.5 focus:outline-none focus:ring-2 focus:ring-zinc-700 resize-none min-h-[56px] max-h-32"
              rows={1}
              disabled={isGenerating}
            />
            <button
              onClick={isGenerating ? handleStop : handleSendMessage}
              disabled={!input.trim() && !isGenerating}
              className={`
                absolute right-2 bottom-2 p-2 rounded-lg transition-all duration-200
                ${(input.trim() || isGenerating)
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
          <div className="text-center mt-2">
              <p className="text-[10px] text-zinc-600">
                  AI responses may be inaccurate. Verify important information.
              </p>
          </div>
        </div>

      </div>

      <AgentModal 
        isOpen={isAgentModalOpen}
        onClose={() => setIsAgentModalOpen(false)}
        onSave={handleAgentSave}
        editingAgent={editingAgent}
      />

      <RelationshipGraphModal 
        isOpen={isGraphModalOpen}
        onClose={() => setIsGraphModalOpen(false)}
        rooms={rooms}
      />
    </div>
  );
}