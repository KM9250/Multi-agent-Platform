
import React from 'react';
import { Box, Loader2 } from 'lucide-react';
import { Agent } from '../types';

interface SceneViewProps {
  agents: Agent[];
  speakingAgentId?: string | null;
}

const SceneView: React.FC<SceneViewProps> = ({ agents, speakingAgentId }) => {
  // This component is designed to host the Unity WebGL Canvas in the future.
  // For now, it visualizes the agents in a "Stage" layout.
  
  const activeAgents = agents.filter(a => a.isEnabled);

  return (
    <div className="w-full h-full bg-zinc-900 relative overflow-hidden flex flex-col">
      {/* Background Grid / Environment Placeholder */}
      <div className="absolute inset-0 opacity-20 pointer-events-none">
        <div className="w-full h-full bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]"></div>
        <div className="absolute bottom-0 left-0 right-0 h-1/2 bg-gradient-to-t from-zinc-900 to-transparent"></div>
      </div>

      <div className="absolute top-4 left-4 z-10 flex items-center gap-2 bg-black/50 backdrop-blur px-3 py-1.5 rounded-full border border-white/10">
        <Box className="w-4 h-4 text-blue-400" />
        <span className="text-xs font-mono text-zinc-300">Unity WebGL Container (Preview)</span>
      </div>

      {/* Stage Area */}
      <div className="flex-1 flex items-end justify-center pb-8 gap-8 perspective-[1000px] px-8 overflow-x-auto custom-scrollbar">
        {activeAgents.length === 0 ? (
           <div className="text-zinc-600 flex flex-col items-center mb-10">
              <Loader2 className="w-8 h-8 animate-spin mb-2" />
              <span className="text-sm">Waiting for agents...</span>
           </div>
        ) : (
          activeAgents.map((agent) => {
            const isSpeaking = speakingAgentId === agent.id;
            
            return (
              <div 
                key={agent.id} 
                className={`
                  relative group flex flex-col items-center transition-all duration-500 ease-out
                  ${isSpeaking ? 'scale-110 -translate-y-2 z-10' : 'scale-100 opacity-80 grayscale-[0.3]'}
                `}
              >
                {/* Speech Bubble Placeholder */}
                {isSpeaking && (
                   <div className="absolute -top-12 opacity-0 animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="bg-white text-black text-[10px] px-2 py-1 rounded-lg font-bold shadow-lg whitespace-nowrap">
                         Speaking...
                      </div>
                      <div className="w-2 h-2 bg-white rotate-45 mx-auto -mt-1"></div>
                   </div>
                )}

                {/* Avatar / 3D Model Placeholder */}
                <div 
                  className={`
                    w-24 h-32 rounded-xl border-2 shadow-2xl flex items-center justify-center relative overflow-hidden bg-zinc-800
                    ${isSpeaking ? 'border-blue-500 ring-4 ring-blue-500/20' : 'border-zinc-700'}
                  `}
                >
                    {/* In a real Unity implementation, this div would be mapped to a GameObject position */}
                    {agent.avatarType === 'image' ? (
                        <img src={agent.avatar} alt={agent.name} className="w-full h-full object-cover" />
                    ) : (
                        <span className="text-6xl filter drop-shadow-lg">{agent.avatar}</span>
                    )}
                    
                    {/* Floor Reflection Effect */}
                    <div className="absolute -bottom-8 left-0 right-0 h-8 bg-gradient-to-b from-black/50 to-transparent"></div>
                </div>

                {/* Name Label */}
                <div className={`
                  mt-3 px-3 py-1 rounded-full text-xs font-medium border transition-colors
                  ${isSpeaking ? 'bg-blue-500/20 text-blue-200 border-blue-500/30' : 'bg-zinc-800 text-zinc-400 border-zinc-700'}
                `}>
                  {agent.name}
                </div>
                
                {/* Floor Shadow */}
                <div className="w-20 h-4 bg-black/50 blur-md rounded-[100%] absolute -bottom-2 -z-10"></div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default SceneView;
