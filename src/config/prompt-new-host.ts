import type { HostConfig } from './config';
export interface InputOptions {
  title: string;
  prompt: string;
  value?: string;
  placeHolder?: string;
  password?: boolean;
  validateInput?: (value: string) => string | undefined;
}

export async function promptNewHost(
  hosts: readonly Pick<HostConfig, 'ip'>[],
  username: () => string,
  input: (options: InputOptions) => Promise<string | undefined>,
  selectAuthentication: (title: string) => Promise<HostConfig['auth']>
) {
  const title = '新增配置';
  const required = (label: string) => (value: string) =>
    value.trim() ? undefined : `${label}不能为空`;
  const name = await input({
    title, prompt: '主机名', value: 'dev', validateInput: required('主机名')
  });
  if (name === undefined) return;
  const ip = await input({
    title,
    prompt: 'IP 地址或主机名',
    value: '10.0.0.1',
    placeHolder: '例如 10.0.0.2 或 server.example.com',
    validateInput: value => required('IP 地址或主机名')(value)
      ?? (hosts.some(host => host.ip === value.trim())
        ? '该主机 IP 已存在，请在已有主机节点下添加账号。' : undefined)
  });
  if (ip === undefined) return;

  const portText = await input({
    title, prompt: '端口', value: '22',
    validateInput: value => {
      const port = Number(value.trim());
      return Number.isInteger(port) && port >= 1 && port <= 65535
        ? undefined : '端口必须是 1 到 65535 之间的整数';
    }
  });
  if (portText === undefined) return;
  const user = await input({
    title, prompt: '账号', value: username(), validateInput: required('账号')
  });
  if (user === undefined) return;
  const auth = await selectAuthentication(title);
  if (!auth) return;

  return { name, ip, portText, user, auth };
}
