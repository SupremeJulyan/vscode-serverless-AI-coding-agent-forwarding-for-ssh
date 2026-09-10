export type CliAgentPlatform = 'wsl' | 'mac' | 'linux' | 'win';

export interface CliAgentIdentityState {
  version: 1;
  agents: Partial<Record<CliAgentPlatform, string>>;
}

export function normalizeCliAgentName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 100 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

export function readCliAgentIdentity(
  value: unknown, platform: CliAgentPlatform
): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const state = value as Partial<CliAgentIdentityState>;
  if (state.version !== 1 || !state.agents || typeof state.agents !== 'object') return undefined;
  return normalizeCliAgentName(state.agents[platform]);
}

export function updateCliAgentIdentity(
  value: unknown, platform: CliAgentPlatform, agentName: string
): CliAgentIdentityState {
  const normalized = normalizeCliAgentName(agentName);
  if (!normalized) throw new Error('Agent name must contain 1 to 100 characters without control characters');
  const previous = value && typeof value === 'object' && !Array.isArray(value)
    && (value as Partial<CliAgentIdentityState>).version === 1
    && (value as Partial<CliAgentIdentityState>).agents
    && typeof (value as Partial<CliAgentIdentityState>).agents === 'object'
    ? (value as CliAgentIdentityState).agents : {};
  return { version: 1, agents: { ...previous, [platform]: normalized } };
}
