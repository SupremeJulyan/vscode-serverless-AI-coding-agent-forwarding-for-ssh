export type AgentInterface = 'hybrid' | 'mcp' | 'cli';

/** One-time upgrade target for the legacy explicit MCP default. */
export function legacyAgentInterfaceMigrationTarget(
  explicitValue: unknown, migrationCompleted: boolean
): AgentInterface | undefined {
  return !migrationCompleted && explicitValue === 'mcp' ? 'hybrid' : undefined;
}
