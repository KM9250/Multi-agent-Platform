import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Agent, Room } from '../types';
import { extractEmotions } from '../constants';

interface RelationshipGraphModalProps {
  isOpen: boolean;
  onClose: () => void;
  rooms: Room[];
}

interface Node {
  id: string;
  name: string;
  avatar: string;
  avatarType: 'emoji' | 'image';
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

interface Edge {
  source: string;
  target: string;
  count: number;
  posSum: number;
  negSum: number;
  weight: number; 
}

const RelationshipGraphModal: React.FC<RelationshipGraphModalProps> = ({ isOpen, onClose, rooms }) => {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  
  // Physics Parameters
  const params = {
    repulsion: 4000,
    springLengthBase: 150,
    springK: 0.05,
    damping: 0.85,
    centerPull: 0.02
  };

  // 1. Data Processing
  useEffect(() => {
    if (!isOpen) return;

    const uniqueAgents = new Map<string, Agent>();
    const interactionMap = new Map<string, { count: number, posSum: number, negSum: number }>();

    // Add User Node placeholder
    const userNode: Partial<Agent> = {
      id: 'user',
      name: 'User',
      avatar: '👤',
      avatarType: 'emoji',
      color: 'bg-zinc-700'
    };

    // Aggregate data from all rooms
    rooms.forEach(room => {
      // Collect Agent definitions
      room.agents.forEach(a => {
        if (!uniqueAgents.has(a.id)) {
          uniqueAgents.set(a.id, a);
        }
      });

      // Analyze Interactions
      for (let i = 1; i < room.messages.length; i++) {
        const curr = room.messages[i];
        const prev = room.messages[i-1];
        
        if (!curr.content) continue;

        const sourceId = curr.role === 'model' ? (curr.agentId || 'unknown') : 'user';
        const targetId = prev.role === 'model' ? (prev.agentId || 'unknown') : 'user';

        if (sourceId === targetId) continue;

        const key = `${sourceId}->${targetId}`;
        const existing = interactionMap.get(key) || { count: 0, posSum: 0, negSum: 0 };
        
        const { posAvg, negAvg } = extractEmotions(curr.content);
        
        interactionMap.set(key, {
          count: existing.count + 1,
          posSum: existing.posSum + posAvg,
          negSum: existing.negSum + negAvg
        });
      }
    });

    // Build Edges
    const alpha = 2.0; 
    const beta = 1.0;  
    const gamma = 1.0; 

    const newEdges: Edge[] = [];
    interactionMap.forEach((val, key) => {
      const [source, target] = key.split('->');
      const sourceExists = source === 'user' || uniqueAgents.has(source);
      const targetExists = target === 'user' || uniqueAgents.has(target);
      
      if (sourceExists && targetExists) {
        const posAvg = val.posSum / val.count;
        const negAvg = val.negSum / val.count;
        const weight = (alpha * val.count) + (beta * posAvg) - (gamma * negAvg);
        
        newEdges.push({
          source,
          target,
          count: val.count,
          posSum: val.posSum,
          negSum: val.negSum,
          weight
        });
      }
    });

    setEdges(newEdges);

    setNodes(prevNodes => {
        const existingNodeMap = new Map<string, Node>(prevNodes.map(n => [n.id, n] as [string, Node]));
        const nextNodes: Node[] = [];
        const width = canvasRef.current?.clientWidth || 800;
        const height = canvasRef.current?.clientHeight || 600;

        const createOrMerge = (agentData: Partial<Agent>) => {
             const existing = existingNodeMap.get(agentData.id!);
             if (existing) {
                 return {
                     ...existing,
                     name: agentData.name || existing.name,
                     avatar: agentData.avatar || existing.avatar,
                     avatarType: agentData.avatarType || existing.avatarType,
                     color: agentData.color || existing.color
                 };
             } else {
                 return {
                    ...agentData,
                     x: Math.random() * width,
                     y: Math.random() * height,
                     vx: 0,
                     vy: 0,
                     radius: agentData.id === 'user' ? 30 : 25
                 } as Node;
             }
        };

        nextNodes.push(createOrMerge(userNode));
        uniqueAgents.forEach(a => {
            nextNodes.push(createOrMerge(a));
        });

        return nextNodes;
    });

  }, [isOpen, rooms]);

  // 2. Physics Simulation
  useEffect(() => {
    if (!isOpen || nodes.length === 0) return;

    let animationFrameId: number;
    
    const tick = () => {
      setNodes(prevNodes => {
        const nextNodes = prevNodes.map(n => ({ ...n })); 
        const width = canvasRef.current?.clientWidth || 800;
        const height = canvasRef.current?.clientHeight || 600;
        const centerX = width / 2;
        const centerY = height / 2;

        for (let i = 0; i < nextNodes.length; i++) {
          const nodeA = nextNodes[i];
          
          const dxC = centerX - nodeA.x;
          const dyC = centerY - nodeA.y;
          nodeA.vx += dxC * params.centerPull;
          nodeA.vy += dyC * params.centerPull;

          for (let j = 0; j < nextNodes.length; j++) {
            if (i === j) continue;
            const nodeB = nextNodes[j];
            const dx = nodeA.x - nodeB.x;
            const dy = nodeA.y - nodeB.y;
            const distSq = dx*dx + dy*dy + 0.1;
            const dist = Math.sqrt(distSq);
            const force = params.repulsion / distSq;
            nodeA.vx += (dx / dist) * force;
            nodeA.vy += (dy / dist) * force;
          }
        }

        edges.forEach(edge => {
          const sourceNode = nextNodes.find(n => n.id === edge.source);
          const targetNode = nextNodes.find(n => n.id === edge.target);
          if (sourceNode && targetNode) {
            const dx = targetNode.x - sourceNode.x;
            const dy = targetNode.y - sourceNode.y;
            const dist = Math.sqrt(dx*dx + dy*dy) + 0.1;

            let targetLen = params.springLengthBase;
            if (edge.weight > 0) {
               targetLen = Math.max(50, params.springLengthBase - (edge.weight * 0.8));
            } else {
               targetLen = params.springLengthBase + (Math.abs(edge.weight) * 1.5);
            }

            const displacement = dist - targetLen;
            const force = displacement * params.springK;
            
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;

            sourceNode.vx += fx;
            sourceNode.vy += fy;
            targetNode.vx -= fx;
            targetNode.vy -= fy;
          }
        });

        for (let i = 0; i < nextNodes.length; i++) {
          const node = nextNodes[i];
          node.vx *= params.damping;
          node.vy *= params.damping;
          node.x += node.vx * 0.1; 
          node.y += node.vy * 0.1;

          if(node.x < 20) node.vx += 5;
          if(node.x > width - 20) node.vx -= 5;
          if(node.y < 20) node.vy += 5;
          if(node.y > height - 20) node.vy -= 5;
        }

        return nextNodes;
      });
      
      animationFrameId = requestAnimationFrame(tick);
    };

    animationFrameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrameId);
  }, [isOpen, edges, params.centerPull, params.damping, params.repulsion, params.springK, params.springLengthBase]);


  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <div className="bg-zinc-950 border border-zinc-800 rounded-2xl w-full max-w-5xl h-[80vh] flex flex-col shadow-2xl relative overflow-hidden">
        
        <div className="flex justify-between items-center p-4 border-b border-zinc-800 bg-zinc-900/50">
          <div>
             <h2 className="text-xl font-bold text-white flex items-center gap-2">
               Relationship Graph
               <span className="text-xs font-normal text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full border border-zinc-700">Live</span>
             </h2>
             <p className="text-xs text-zinc-400 mt-1">
               Real-time visualization of agent interaction frequency and emotional resonance.
             </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-zinc-800 rounded-full text-zinc-400 hover:text-white transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="absolute top-20 left-4 z-10 bg-black/40 backdrop-blur p-3 rounded-lg border border-white/10 text-xs text-zinc-300 space-y-2 pointer-events-none">
           <div className="font-semibold text-zinc-100 mb-1">Connections</div>
           <div className="flex items-center gap-2"><div className="w-8 h-1 bg-green-500 rounded"></div> Positive Bond</div>
           <div className="flex items-center gap-2"><div className="w-8 h-1 bg-zinc-600 rounded"></div> Neutral / Frequency</div>
           <div className="flex items-center gap-2"><div className="w-8 h-1 bg-red-500 rounded"></div> Negative / Tension</div>
           <div className="mt-2 text-[10px] opacity-70">
              Thickness = Interaction Count<br/>
              Distance = Relationship Strength
           </div>
        </div>

        <div className="flex-1 relative bg-[#09090b]" ref={canvasRef}>
           <svg width="100%" height="100%" className="absolute inset-0">
              <defs>
                <marker id="arrowhead-green" markerWidth="10" markerHeight="7" refX="28" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="#22c55e" />
                </marker>
                <marker id="arrowhead-red" markerWidth="10" markerHeight="7" refX="28" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="#ef4444" />
                </marker>
                <marker id="arrowhead-gray" markerWidth="10" markerHeight="7" refX="28" refY="3.5" orient="auto">
                  <polygon points="0 0, 10 3.5, 0 7" fill="#52525b" />
                </marker>
              </defs>
              
              {edges.map((edge, idx) => {
                const source = nodes.find(n => n.id === edge.source);
                const target = nodes.find(n => n.id === edge.target);
                if (!source || !target) return null;

                let strokeColor = '#52525b'; 
                let markerId = 'url(#arrowhead-gray)';
                
                if (edge.weight > 20) {
                    strokeColor = '#22c55e'; 
                    markerId = 'url(#arrowhead-green)';
                } else if (edge.weight < -10) {
                    strokeColor = '#ef4444'; 
                    markerId = 'url(#arrowhead-red)';
                }

                const strokeWidth = Math.min(8, Math.max(1.5, Math.log(edge.count + 1) * 2));
                const isDimmed = hoveredNode && hoveredNode !== edge.source && hoveredNode !== edge.target;

                return (
                  <g key={`${edge.source}-${edge.target}`} className="transition-opacity duration-300" style={{ opacity: isDimmed ? 0.1 : 0.8 }}>
                     <line 
                        x1={source.x} y1={source.y}
                        x2={target.x} y2={target.y}
                        stroke={strokeColor}
                        strokeWidth={strokeWidth}
                        markerEnd={markerId}
                     />
                     {!isDimmed && (hoveredNode === edge.source || hoveredNode === edge.target) && (
                         <text 
                            x={(source.x + target.x) / 2} 
                            y={(source.y + target.y) / 2 - 10} 
                            fill={strokeColor}
                            textAnchor="middle"
                            fontSize="10"
                            className="font-mono bg-black"
                         >
                            {Math.round(edge.weight)}
                         </text>
                     )}
                  </g>
                );
              })}

              {nodes.map(node => (
                <g 
                    key={node.id} 
                    transform={`translate(${node.x}, ${node.y})`}
                    onMouseEnter={() => setHoveredNode(node.id)}
                    onMouseLeave={() => setHoveredNode(null)}
                    className="cursor-pointer"
                >
                  <circle 
                    r={node.radius + 4} 
                    className="fill-zinc-900 stroke-zinc-700 hover:stroke-white transition-colors" 
                    strokeWidth="2"
                  />
                   <foreignObject x={-node.radius} y={-node.radius} width={node.radius * 2} height={node.radius * 2} className="pointer-events-none">
                      <div className={`w-full h-full rounded-full flex items-center justify-center text-xl overflow-hidden ${node.avatarType === 'image' ? 'bg-zinc-800' : node.color}`}>
                         {node.avatarType === 'image' ? (
                            <img src={node.avatar} alt={node.name} className="w-full h-full object-cover" />
                         ) : (
                            node.avatar
                         )}
                      </div>
                   </foreignObject>
                  
                  <text 
                    y={node.radius + 15} 
                    textAnchor="middle" 
                    className="fill-zinc-300 text-[10px] font-medium pointer-events-none drop-shadow-md"
                  >
                    {node.name}
                  </text>
                </g>
              ))}
           </svg>
        </div>
      </div>
    </div>
  );
};

export default RelationshipGraphModal;