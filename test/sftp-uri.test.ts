import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeRemoteEntryName, isRemotePathInsideRoot, legacyMountAuthorityAlias, mountAuthorityAlias,
  normalizeRemotePath, parseRemoteUri, remoteUri, resolvedRemoteRoot, setMountAliasResolver
} from '../src/sftp/uri';
import { mountAliasCandidates } from '../src/mount-aliases';

test('round-trips remote folder names and unusual POSIX paths', () => {
  const uri = remoteUri("项目 A/O'Brien", "/srv/项目 A/O'Brien/[草稿] #1.ts");
  assert.deepEqual(parseRemoteUri(uri), {
    mountName: "项目 A/O'Brien",
    remotePath: "/srv/项目 A/O'Brien/[草稿] #1.ts"
  });
  assert.equal(uri.includes('项目'), false);
  assert.equal(uri.includes('#'), false);
});

test('keeps generated host(account) config names readable in the authority', () => {
  const uri = remoteUri('192.0.2.10(alice)', '/home/alice');
  // 括号必须转义：VS Code 会把 authority 里的括号存成 %28/%29，直接写括号会让
  // 远程指示器和已保存的窗口状态里出现 `192.0.2.10%28alice%29`。
  assert.equal(uri, 'safs://192.0.2.10_alice/home/alice?mount=192.0.2.10(alice)');  // 名字里没有下划线，转义结果不变
  assert.equal(uri.includes('%28'), false);
  assert.deepEqual(parseRemoteUri(uri), {
    mountName: '192.0.2.10(alice)',
    remotePath: '/home/alice'
  });
  // VS Code 已经把括号编码进 authority 的旧 URI（没有 ?mount=）也要能解析。
  assert.deepEqual(parseRemoteUri('safs://192.0.2.40%28alice%29/home/alice'), {
    mountName: '192.0.2.40(alice)',
    remotePath: '/home/alice'
  });
  // 重名时追加的 `#` 不是安全字符：仍退回十六进制 authority，解析无损。
  const duplicate = remoteUri('192.0.2.10(alice)#2', '/home');
  assert.match(duplicate, /^safs:\/\/m-[0-9a-f]+\//);
  assert.equal(parseRemoteUri(duplicate).mountName, '192.0.2.10(alice)#2');
  // 非 ASCII 账号逐字符转义，原名走 query。
  const unicodeUser = remoteUri('192.0.2.10(测试)', '/home');
  assert.match(unicodeUser, /^safs:\/\/192\.0\.2\.10__u6d4b_u8bd5\//);
  assert.equal(parseRemoteUri(unicodeUser).mountName, '192.0.2.10(测试)');
});

test('resolves legacy config names so renamed mounts keep their open windows', () => {
  setMountAliasResolver((name) => (name === 'alice_ws1' ? '192.0.2.40(alice)' : name));
  try {
    assert.equal(
      parseRemoteUri('safs://alice_ws1/home/alice').mountName,
      '192.0.2.40(alice)'
    );
    // 旧名字同样可能带着 ?mount= 或转义形式，解析后都落到当前配置名。
    assert.equal(parseRemoteUri(remoteUri('alice_ws1', '/home')).mountName, '192.0.2.40(alice)');
    assert.equal(parseRemoteUri('safs://other/home').mountName, 'other');
  } finally {
    setMountAliasResolver((name) => name);
  }
});

test('recovers the mount name when VS Code escapes the ?mount query', () => {
  // VS Code 保存工作区时会把 query 里的 `=` 转义成 `%3D`（旧实现里
  // `?mount=host@user` 就变成了 `?mount%3Dhost@user`），此时必须靠 authority 还原。
  const mangled = 'safs://192.0.2.10_alice/home/x?mount%3D192.0.2.10(alice)';
  assert.equal(new URL(mangled).searchParams.get('mount'), null);
  assert.equal(mountAuthorityAlias('192.0.2.10(alice)'), '192.0.2.10_alice');
  assert.equal(mountAuthorityAlias('gateway'), undefined);
  setMountAliasResolver((name) =>
    (name === '192.0.2.10_alice' ? '192.0.2.10(alice)' : name));
  try {
    assert.equal(parseRemoteUri(mangled).mountName, '192.0.2.10(alice)');
  } finally {
    setMountAliasResolver((name) => name);
  }
  // 没有登记别名时退回 authority 本身，至少不会抛错。
  assert.equal(parseRemoteUri(mangled).mountName, '192.0.2.10_alice');
});

test('uses the config name as the authority when it is URI-safe', () => {
  const uri = remoteUri('gateway', '/home/alice');
  assert.equal(uri, 'safs://gateway/home/alice');
  assert.deepEqual(parseRemoteUri(uri), {
    mountName: 'gateway',
    remotePath: '/home/alice'
  });
  const hierarchical = remoteUri('192.0.2.12@dev_carol', '/home/alice');
  // 字面下划线写成 `__`（保证单射），`@` 写成 `_`；上一版的 `192.0.2.12_dev_carol`
  // 仍能通过 legacyMountAuthorityAlias 找回（见 mountAliasCandidates）。
  assert.equal(
    hierarchical,
    'safs://192.0.2.12_dev__carol/home/alice?mount=192.0.2.12%40dev_carol'
  );
  assert.deepEqual(parseRemoteUri(hierarchical), {
    mountName: '192.0.2.12@dev_carol',
    remotePath: '/home/alice'
  });
  const unicodeHost = remoteUri('alice_测试主机', '/home/alice');
  assert.equal(unicodeHost.includes('m-'), false);
  // 字面下划线写成 `__`，非 ASCII 逐字符写成 `_uXXXX`（因此这里会出现三个下划线）。
  assert.match(unicodeHost, /^safs:\/\/alice___u6d4b_u8bd5_u4e3b_u673a\//);
  assert.deepEqual(parseRemoteUri(unicodeHost), {
    mountName: 'alice_测试主机',
    remotePath: '/home/alice'
  });
  // Unsafe names (uppercase/space) fall back to the legacy hex authority.
  const hex = remoteUri('My Host', '/home');
  assert.match(hex, /^safs:\/\/m-[0-9a-f]+\//);
  assert.deepEqual(parseRemoteUri(hex), { mountName: 'My Host', remotePath: '/home' });
  // Legacy hex authorities still decode (backward compatibility).
  assert.equal(parseRemoteUri('safs://m-67617465776179/home/alice').mountName, 'gateway');
});

test('normalizes remote paths with POSIX rules on every local platform', () => {
  assert.equal(normalizeRemotePath('/srv/project/./src/../README.md'), '/srv/project/README.md');
  assert.throws(() => normalizeRemotePath('C:\\srv\\project'), /must be absolute/);
  assert.throws(() => normalizeRemotePath('relative/path'), /must be absolute/);
});

test('checks that agent paths remain inside the configured remote root', () => {
  assert.equal(isRemotePathInsideRoot('/srv/project', '/srv/project'), true);
  assert.equal(isRemotePathInsideRoot('/srv/project', '/srv/project/src/index.ts'), true);
  assert.equal(isRemotePathInsideRoot('/srv/project', '/srv/project-old/file'), false);
  assert.equal(isRemotePathInsideRoot('/srv/project', '/srv/project/../../etc/passwd'), false);
});

test('rejects remote directory entry names that can escape a local target', () => {
  assert.doesNotThrow(() => assertSafeRemoteEntryName('normal file.txt'));
  for (const name of ['', '.', '..', '../escape', 'dir/file', 'dir\\file', 'nul\0byte']) {
    assert.throws(() => assertSafeRemoteEntryName(name), /Unsafe remote directory entry/);
  }
});

test('resolves dot and relative roots through the server realpath result', () => {
  assert.equal(resolvedRemoteRoot('.', '/home/alice'), '/home/alice');
  assert.equal(resolvedRemoteRoot('projects/app', '/home/alice/projects/app'), '/home/alice/projects/app');
  assert.equal(resolvedRemoteRoot('/srv/app/', '/ignored'), '/srv/app/');
});

test('rejects malformed or unrelated remote URIs', () => {
  assert.throws(() => parseRemoteUri('file:///srv/project'), /Unsupported remote URI scheme/);
  assert.throws(
    () => parseRemoteUri('safs://user@project/srv'),
    /Invalid remote workspace URI/
  );
});

test('ignores cache metadata appended by VS Code media previews', () => {
  assert.deepEqual(
    parseRemoteUri(`${remoteUri('project', '/srv/效果图.png')}?version%3D123#preview`),
    { mountName: 'project', remotePath: '/srv/效果图.png' }
  );
});

test('authority escaping is injective, so two names never share one authority', () => {
  const left = remoteUri('devbox(alice_k)', '/home');
  const right = remoteUri('devbox_alice(k)', '/home');
  assert.equal(left.includes('safs://devbox_alice__k/'), true);
  assert.equal(right.includes('safs://devbox__alice_k/'), true);
  // 只看 authority（?mount= 会被 VS Code 转义掉）也不会串台。
  assert.notEqual(left.split('?')[0], right.split('?')[0]);
  assert.equal(parseRemoteUri(left).mountName, 'devbox(alice_k)');
  assert.equal(parseRemoteUri(right).mountName, 'devbox_alice(k)');
  // 上一版的非单射转义形式仍能还原（已存进窗口状态的 URI 就是它）。
  assert.equal(legacyMountAuthorityAlias('devbox(alice_k)'), 'devbox_alice_k');
  assert.equal(mountAliasCandidates(
    { name: 'devbox(alice_k)', ip: '192.0.2.1', user: 'alice_k' },
    { '192.0.2.1': 'devbox' }
  ).includes('devbox_alice_k'), true);
});

test('names that look like the legacy hex form never use a plain authority', () => {
  const uri = remoteUri('m-ab', '/home');
  assert.equal(uri.startsWith('safs://m-ab/'), false);
  assert.equal(parseRemoteUri(uri).mountName, 'm-ab');
  assert.equal(parseRemoteUri('safs://m-67617465776179/home').mountName, 'gateway');
});
