import type { Agent, AgentContextFile } from '../types';

const byteSize = (text: string): number => new TextEncoder().encode(text).length;

export const normalizeContextFileOrder = (files: AgentContextFile[] = []): AgentContextFile[] =>
  files
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map((file, index) => ({
      ...file,
      id: file.id || `context-${index}-${file.name || 'file'}`,
      name: file.name || 'legacy-context.md',
      content: file.content ?? '',
      mimeType: file.mimeType || 'text/markdown',
      charCount: typeof file.charCount === 'number' ? file.charCount : (file.content ?? '').length,
      sizeBytes: typeof file.sizeBytes === 'number' ? file.sizeBytes : byteSize(file.content ?? ''),
      order: index,
      addedAt: file.addedAt || 0,
    }));

export const normalizeAgent = (agent: Agent, now = Date.now()): Agent => {
  if (Array.isArray(agent.additionalContextFiles)) {
    return { ...agent, additionalContextFiles: normalizeContextFileOrder(agent.additionalContextFiles) };
  }

  if (!agent.importedSystemInstruction) {
    return { ...agent, additionalContextFiles: [] };
  }

  const content = agent.importedSystemInstruction;
  return {
    ...agent,
    additionalContextFiles: [{
      id: `legacy-${agent.id}-${byteSize(content)}-${content.length}`,
      name: agent.importedSystemInstructionFileName || 'legacy-context.md',
      content,
      mimeType: 'text/markdown',
      charCount: content.length,
      sizeBytes: byteSize(content),
      order: 0,
      addedAt: now,
    }]
  };
};

export const buildAdditionalContext = (files: AgentContextFile[] = []): string =>
  normalizeContextFileOrder(files)
    .map((file, index) => [
      `--- ADDITIONAL CONTEXT ${index + 1}: ${file.name} ---`,
      file.content ?? '',
      `--- END CONTEXT: ${file.name} ---`,
    ].join('\n'))
    .join('\n\n');

export const createAgentContextFile = (file: File, content: string, order: number): AgentContextFile => ({
  id: crypto.randomUUID(),
  name: file.name,
  content,
  mimeType: file.type || (file.name.endsWith('.txt') ? 'text/plain' : 'text/markdown'),
  charCount: content.length,
  sizeBytes: file.size || byteSize(content),
  order,
  addedAt: Date.now(),
});
