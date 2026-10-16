export type AgentInterface = 'mcp' | 'cli';

export function normalizeAgentInterface(value: unknown): AgentInterface {
  return value === 'mcp' ? 'mcp' : 'cli';
}

export function shouldCopyMcpUninstallPrompt(
  previous: AgentInterface, current: AgentInterface
): boolean {
  return previous === 'mcp' && current === 'cli';
}

export function recordedMcpAgentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const name = candidate.trim();
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) continue;
    if (names.some((existing) => existing.toLocaleLowerCase() === name.toLocaleLowerCase())) continue;
    names.push(name);
    if (names.length === 50) break;
  }
  return names;
}

export function addRecordedMcpAgentName(names: string[], agentName: string): string[] {
  return recordedMcpAgentNames([...names, agentName]);
}
