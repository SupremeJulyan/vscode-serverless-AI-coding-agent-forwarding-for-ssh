const proxyVariableNames = [
  'ALL_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY',
  'all_proxy', 'https_proxy', 'http_proxy'
] as const;

const loopbackHosts = ['localhost', '127.0.0.1', '::1'] as const;

export interface ProxyEnvironmentWarning {
  proxyVariables: string[];
  missingLoopbackHosts: string[];
}

function noProxyHost(value: string): string {
  let entry = value.trim().toLowerCase();
  if (!entry) return '';
  try {
    if (entry.includes('://')) entry = new URL(entry).hostname.toLowerCase();
  } catch {
    return entry;
  }
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(entry);
  if (bracketed) return bracketed[1];
  if (/^[^:]+:\d+$/.test(entry)) entry = entry.replace(/:\d+$/, '');
  return entry.replace(/^\./, '');
}

/** Inspect standard proxy variables without retaining or exposing their values. */
export function proxyEnvironmentWarning(
  environment: Record<string, string | undefined>
): ProxyEnvironmentWarning | undefined {
  const proxyVariables = proxyVariableNames.filter(
    (name) => environment[name]?.trim()
  );
  if (!proxyVariables.length) return undefined;
  const noProxy = `${environment.NO_PROXY ?? ''},${environment.no_proxy ?? ''}`
    .split(/[\s,]+/)
    .map(noProxyHost)
    .filter(Boolean);
  if (noProxy.includes('*')) return undefined;
  const missingLoopbackHosts = loopbackHosts.filter((host) => !noProxy.includes(host));
  return missingLoopbackHosts.length ? { proxyVariables, missingLoopbackHosts } : undefined;
}
