
import React, { useState } from 'react';
import { Plus, Settings, Trash2, Edit3, MessageSquare, Bot, X, Network, Loader2 } from 'lucide-react';
import { Agent, Room } from '../types';
import { ROOM_TAGS } from '../constants';

interface SidebarProps {
  // Rooms
  rooms: Room[];
  activeRoomId: string;
  onSwitchRoom: (id: string) => void;
  onNewRoom: () => void;
  onDeleteRoom: (id: string) => void;
  
  // Agents (Active Room)
  agents: Agent[];
  onToggleAgent: (id: string) => void;
  onDeleteAgent: (id: string) => void;
  onEditAgent: (agent: Agent) => void;
  onAddAgent: () => void;
  
  // State
  thinkingAgentIds: string[]; // Agents currently processing/deciding
  
  // Graph Trigger
  onShowGraph: () => void;

  isOpen: boolean;
  onClose: () => void;
}

const AgentSidebar: React.FC<SidebarProps> = ({
  rooms,
  activeRoomId,
  onSwitchRoom,
  onNewRoom,
  onDeleteRoom,
  agents,
  onToggleAgent,
  onDeleteAgent,
  onEditAgent,
  onAddAgent,
  thinkingAgentIds,
  onShowGraph,
  isOpen,
  onClose
}) => {
  const [activeTab, setActiveTab] = useState<'chats' | 'agents'>('chats');

  const getTagColor = (tagName: string) => {
    const tag = ROOM_TAGS.find(t => t.value === tagName);
    return tag ? tag.color : 'bg-zinc-700 text-zinc-300 border-zinc-600';
  };

  const renderRoomList = () => (
    <div className="space-y-2">
      <button
        onClick={onNewRoom}
        className="w-full py-3 px-4 rounded-xl border border-dashed border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 hover:bg-zinc-800/50 transition-all flex items-center justify-center gap-2 group mb-4"
      >
        <div className="w-6 h-6 rounded-full bg-zinc-800 group-hover:bg-zinc-700 flex items-center justify-center transition-colors">
          <Plus className="w-4 h-4" />
        </div>
        <span className="text-sm font-medium">New Chat</span>
      </button>

      <div className="space-y-1">
        {rooms.sort((a,b) => b.updatedAt - a.updatedAt).map((room) => (
          <div 
            key={room.id}
            onClick={() => onSwitchRoom(room.id)}
            className={`
              group relative flex flex-col gap-1 p-3 rounded-xl cursor-pointer transition-all duration-200 border
              ${room.id === activeRoomId 
                ? 'bg-zinc-800 border-zinc-700/50 shadow-md' 
                : 'border-transparent text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'}
            `}
          >
            <div className="flex items-center gap-3">
               <MessageSquare className={`w-4 h-4 shrink-0 ${room.id === activeRoomId ? 'text-blue-400' : 'text-zinc-600'}`} />
               <h4 className={`font-medium text-sm truncate flex-1 ${room.id === activeRoomId ? 'text-zinc-100' : 'text-zinc-400'}`}>
                 {room.title || "New Chat"}
               </h4>
               {rooms.length > 1 && (
                <button 
                  onClick={(e) => { e.stopPropagation(); onDeleteRoom(room.id); }}
                  className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded text-zinc-500 hover:text-red-400 transition-all shrink-0"
                  title="Delete Chat"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            
            <div className="flex items-center gap-2 pl-7">
               {room.type && (
                 <span className={`text-[9px] px-1.5 py-0.5 rounded border ${getTagColor(room.type)}`}>
                   {room.type}
                 </span>
               )}
               <span className="text-[10px] text-zinc-500 truncate flex-1">
                  {room.description || new Date(room.updatedAt).toLocaleDateString()}
               </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderAgentList = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Room Agents</h3>
        {agents.map((agent) => {
          const isThinking = thinkingAgentIds.includes(agent.id);
          
          return (
            <div 
              key={agent.id}
              className={`
                group relative flex items-start gap-3 p-3 rounded-xl border transition-all duration-200
                ${agent.isEnabled 
                  ? 'bg-zinc-800/50 border-zinc-700 hover:border-zinc-600' 
                  : 'bg-zinc-900 border-zinc-800 opacity-60 hover:opacity-100'}
                ${isThinking ? 'border-purple-500/30 bg-purple-500/5' : ''}
              `}
            >
              <div className="relative">
                <div 
                  className={`
                    w-10 h-10 rounded-full flex items-center justify-center text-lg shadow-sm shrink-0 overflow-hidden 
                    ${agent.avatarType === 'image' ? 'bg-zinc-800' : agent.color}
                    ${isThinking ? 'ring-2 ring-purple-500 ring-offset-2 ring-offset-zinc-900' : ''}
                    transition-all duration-300
                  `}
                >
                  {agent.avatarType === 'image' ? (
                      <img src={agent.avatar} alt={agent.name} className="w-full h-full object-cover" />
                    ) : (
                      agent.avatar
                    )}
                </div>
                {isThinking && (
                  <div className="absolute -top-1 -right-1 flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-purple-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-purple-500"></span>
                  </div>
                )}
              </div>
              
              <div className="flex-1 min-w-0">
                <div className="flex justify-between items-center mb-0.5">
                  <h4 className="font-medium text-zinc-200 truncate pr-2">{agent.name}</h4>
                  <button
                    onClick={() => onToggleAgent(agent.id)}
                    className={`
                      w-8 h-5 rounded-full relative transition-colors duration-200 focus:outline-none
                      ${agent.isEnabled ? 'bg-green-500/20' : 'bg-zinc-700'}
                    `}
                  >
                    <div className={`
                      w-3 h-3 rounded-full absolute top-1 transition-all duration-200
                      ${agent.isEnabled ? 'left-4 bg-green-500' : 'left-1 bg-zinc-500'}
                    `} />
                  </button>
                </div>
                <p className="text-xs text-zinc-400 truncate">{agent.description}</p>
                <div className="flex items-center gap-2 mt-1">
                  <p className="text-[10px] text-zinc-500 font-mono truncate flex-1">{agent.model}</p>
                  {isThinking && (
                     <span className="text-[10px] text-purple-400 flex items-center gap-1 font-medium animate-pulse">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Thinking
                     </span>
                  )}
                </div>
              </div>

              {/* Actions that appear on hover */}
              <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 bg-zinc-900/90 rounded-md p-1 border border-zinc-800 shadow-xl backdrop-blur-sm z-10">
                <button 
                  onClick={() => onEditAgent(agent)}
                  className="p-1.5 hover:bg-zinc-700 rounded text-zinc-400 hover:text-white transition-colors"
                  title="Edit Agent"
                >
                  <Edit3 className="w-3.5 h-3.5" />
                </button>
                <button 
                  onClick={() => onDeleteAgent(agent.id)}
                  className="p-1.5 hover:bg-red-500/20 rounded text-zinc-400 hover:text-red-400 transition-colors"
                  title="Delete Agent"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button
        onClick={onAddAgent}
        className="w-full py-3 px-4 rounded-xl border border-dashed border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 hover:bg-zinc-800/50 transition-all flex items-center justify-center gap-2 group"
      >
        <div className="w-6 h-6 rounded-full bg-zinc-800 group-hover:bg-zinc-700 flex items-center justify-center transition-colors">
          <Plus className="w-4 h-4" />
        </div>
        <span className="text-sm font-medium">Add Agent to Room</span>
      </button>
    </div>
  );

  return (
    <>
      {/* Mobile Overlay */}
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-20 md:hidden" 
          onClick={onClose}
        />
      )}
      
      {/* Sidebar Container */}
      <div className={`
        fixed inset-y-0 left-0 z-30 w-80 bg-zinc-900 border-r border-zinc-800 transform transition-transform duration-300 ease-in-out
        ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        md:relative md:translate-x-0 flex flex-col
      `}>
        {/* Header Tabs */}
        <div className="p-2 border-b border-zinc-800 grid grid-cols-2 gap-1 bg-zinc-950/50">
          <button
            onClick={() => setActiveTab('chats')}
            className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'chats' 
                ? 'bg-zinc-800 text-white shadow-sm' 
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
            }`}
          >
            <MessageSquare className="w-4 h-4" />
            Chats
          </button>
          <button
            onClick={() => setActiveTab('agents')}
            className={`flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              activeTab === 'agents' 
                ? 'bg-zinc-800 text-white shadow-sm' 
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/50'
            }`}
          >
            <Bot className="w-4 h-4" />
            Agents
          </button>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
          {activeTab === 'chats' ? renderRoomList() : renderAgentList()}
        </div>

        {/* Footer Actions */}
        <div className="p-3 border-t border-zinc-800 bg-zinc-950/30">
           <button 
             onClick={onShowGraph}
             className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-zinc-800/50 text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors border border-zinc-700/50"
           >
             <Network className="w-4 h-4" />
             <span className="text-sm">Relationship Graph</span>
           </button>
        </div>
        
        {/* Mobile Close Button */}
        <button 
          onClick={onClose}
          className="md:hidden absolute top-4 right-[-3rem] p-2 bg-zinc-800 text-zinc-400 rounded-r-lg"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </>
  );
};

export default AgentSidebar;
