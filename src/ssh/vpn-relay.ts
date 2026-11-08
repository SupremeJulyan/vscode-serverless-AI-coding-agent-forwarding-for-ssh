import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HostConfig } from '../config/config';
import { vpnRelayPoolPath } from '../platform/wsl-bridge';
const execFileAsync = promisify(execFile);
interface RelayLease {
  host: string;
  port: number;
  release(): Promise<void>;
}
export async function acquireWslVpnRelay(host: HostConfig): Promise<RelayLease> {
  const script = vpnRelayPoolPath();
  const targetPort = host.port ?? 22;
  const holder = `vscode-sftp-${process.pid}-${host.name}`;
  const command = ['source "$1"', 'vpn_relay_acquire "$2" "$3" "$4"'].join(' && ');
  const { stdout } = await execFileAsync(
    'bash',
    ['-c', command, 'safs-relay', script, host.ip, String(targetPort), holder],
    { timeout: 30_000 }
  );
  const fields = stdout.trim().split(/\s+/);
  const localPort = Number(fields[1]);
  if (!Number.isInteger(localPort) || localPort <= 0 || localPort > 65535) {
    throw new Error(`WSL VPN 中继返回了无效端口：${stdout.trim()}`);
  }
  return {
    host: '127.0.0.1',
    port: localPort,
    release: async () => {
      await execFileAsync(
        'bash',
        [
          '-c',
          'source "$1" && vpn_relay_release "$2" "$3" "$4"',
          'safs-relay',
          script,
          host.ip,
          String(targetPort),
          holder
        ],
        { timeout: 30_000 }
      ).then(
        () => undefined,
        () => undefined
      );
    }
  };
}
