export type AgentInterface = 'mcp' | 'cli';

export function normalizeAgentInterface(value: unknown): AgentInterface {
  return value === 'cli' ? 'cli' : 'mcp';
}
