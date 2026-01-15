
import { AgentFramework } from '../types';

/**
 * Interface for Agent Strategies.
 * This allows us to plug in different reasoning models (ReAct, CoT, etc.) easily.
 */
interface FrameworkStrategy {
  id: AgentFramework;
  name: string;
  description: string;
  injectSystemPrompt: (baseInstruction: string) => string;
}

export const STRATEGIES: Record<AgentFramework, FrameworkStrategy> = {
  standard: {
    id: 'standard',
    name: 'Standard (Direct)',
    description: 'Direct response without explicit reasoning steps. Best for casual chat.',
    injectSystemPrompt: (base) => base,
  },
  cot: {
    id: 'cot',
    name: 'Chain of Thought (CoT)',
    description: 'Encourages step-by-step reasoning before answering.',
    injectSystemPrompt: (base) => {
      return `${base}\n\n` +
        `=== FRAMEWORK: CHAIN OF THOUGHT ===\n` +
        `Before answering, you must break down the user's request into logical steps.\n` +
        `Use the format:\n` +
        `[THOUGHT]\n` +
        `1. First, I will...\n` +
        `2. Then, I consider...\n` +
        `3. Finally, I conclude...\n` +
        `[/THOUGHT]\n` +
        `Then provide your final response naturally.`;
    },
  },
  react: {
    id: 'react',
    name: 'ReAct (Reasoning + Acting)',
    description: 'Simulated ReAct loop. Agent thinks, plans actions, and observes variables.',
    injectSystemPrompt: (base) => {
      return `${base}\n\n` +
        `=== FRAMEWORK: ReAct (Reason+Act) ===\n` +
        `You are operating under a ReAct framework. Do not answer immediately. \n` +
        `Instead, use the following format to structure your response:\n\n` +
        `[THOUGHT]\n` +
        `Target: (What is the user's goal?)\n` +
        `Emotion: (Analyze the emotion parameters and how they affect the task)\n` +
        `Plan: (What specific steps or tools are needed?)\n` +
        `[/THOUGHT]\n\n` +
        `[ACTION]\n` +
        `(If you were a real agent, what function would you call? e.g., Search, Calculate. If none, state "None")\n` +
        `[/ACTION]\n\n` +
        `Final Response:\n` +
        `(Your actual response to the user)`;
    },
  },
};

export const getStrategy = (frameworkId: string): FrameworkStrategy => {
  return STRATEGIES[frameworkId as AgentFramework] || STRATEGIES.standard;
};
