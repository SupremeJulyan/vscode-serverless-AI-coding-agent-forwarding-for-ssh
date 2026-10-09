const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('password-configured bridge probes need no ASKPASS; logins still require it', {
  // The bundled WSL bridge uses Linux utilities and is not a native macOS path.
  skip: process.platform !== 'linux'
}, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'safs-bridge-test-'));
  try {
    writeFileSync(path.join(dir, 'ssh'), '#!/bin/sh\necho OpenSSH_9.6 >&2\n', { mode: 0o700 });
    writeFileSync(path.join(dir, 'ssh-keyscan'),
      '#!/bin/sh\n[ "$SAFS_TEST_EMPTY_SCAN" = 1 ] && exit 1\nprintf "%s\\n" "192.0.2.4 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest"\n',
      { mode: 0o700 });
    const configPath = path.join(dir, 'config.json');
    const env = {
      ...process.env, PATH: `${dir}:${process.env.PATH}`,
      WSL_VPN_SSH_CONFIG: configPath
    };
    delete env.SSH_ASKPASS;
    delete env.VPN_TARGET_PORT;
    delete env.SAFS_TEST_EMPTY_SCAN;
    const bridge = path.resolve(__dirname, '../resources/wsl/ssh-bridge');
    const run = (args, extraEnv = {}) => spawnSync('bash', [bridge, ...args], {
      env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 5000
    });
    const account = { user: 'alice', password: 'encrypted:test', port: 2222, vpn: false };
    for (const config of [
      [{ ...account, name: '192.0.2.4(alice)', ip: '192.0.2.4' }],
      { hosts: [{ ip: '192.0.2.4', accounts: [account] }] }
    ]) {
      writeFileSync(configPath, JSON.stringify(config));
      const probe = run(['probe', '192.0.2.4(alice)']);
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout,
        'PROBE_OK [192.0.2.4]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITest\n');

      const login = run(['192.0.2.4(alice)', 'true']);
      assert.equal(login.status, 1);
      assert.match(login.stderr, /配置包含密码，但扩展未提供 SSH_ASKPASS 凭据/);

      const empty = run(['probe', '192.0.2.4(alice)'], { SAFS_TEST_EMPTY_SCAN: '1' });
      assert.equal(empty.status, 1);
      assert.match(empty.stderr, /PROBE_FAIL ssh-keyscan 未返回任何主机密钥/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
