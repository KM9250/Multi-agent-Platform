import type { CoordinationEvent } from './types';
export const PLANNING_EVENTS = new Set(['PlanArtifactPublished','PlanningReadRequested','PlanningInputRequested']);
export function validatePlanningEvent(event:CoordinationEvent, supervisor:string):void {
  if(!PLANNING_EVENTS.has(event.type))return;
  const p=event.payload as Record<string,unknown>;
  if(event.sessionId!==undefined || event.actorAgentId!==supervisor || !p ||
    Object.keys(p).some(k=>!['invocationId','modelCallId','referenceId','contentDigest'].includes(k)) ||
    ['invocationId','modelCallId','referenceId'].some(k=>typeof p[k]!=='string'||!String(p[k]).trim()) ||
    typeof p.contentDigest!=='string'||!/^[a-f0-9]{64}$/.test(p.contentDigest)) throw new Error('Invalid planning event.');
}
