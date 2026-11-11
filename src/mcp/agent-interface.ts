export type AgentInterface = 'mcp' | 'cli';
export function normalizeAgentInterface(value: unknown): AgentInterface { return value === 'mcp' ? 'mcp' : 'cli'; }
export function shouldCopyMcpUninstallPrompt(previous: AgentInterface, current: AgentInterface, focused: boolean): boolean {
  return focused && previous === 'mcp' && current === 'cli';
}
export function recordedMcpAgentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const name = candidate.trim();
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)
      || names.some((item) => item.toLowerCase() === name.toLowerCase())) continue;
    names.push(name);
    if (names.length === 50) break;
  }
  return names;
}
export function addRecordedMcpAgentName(names: string[], name: string): string[] {
  return recordedMcpAgentNames([...names, name]);
}
