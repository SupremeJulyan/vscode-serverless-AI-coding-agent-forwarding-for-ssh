import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeRemoteEntryName, isRemotePathInsideRoot, mountAuthorityAlias, normalizeRemotePath,
  parseRemoteUri, remoteUri, resolvedRemoteRoot, setMountAliasResolver
} from '../src/sftp/uri';

test('round-trips remote folder names and unusual POSIX paths', () => {
  const uri = remoteUri("项目 A/O'Brien", "/srv/项目 A/O'Brien/[草稿] #1.ts");
  assert.deepEqual(parseRemoteUri(uri), {
    mountName: "项目 A/O'Brien",
    remotePath: "/srv/项目 A/O'Brien/[草稿] #1.ts"
  });
  assert.equal(uri.includes('项目'), false);
  assert.equal(uri.includes('#'), false);
});

test('keeps generated IP(account) config names readable in the authority', () => {
  const uri = remoteUri('10.68.0.1(zhuyuan)', '/home/zhuyuan');
  // 括号必须转义：VS Code 会把 authority 里的括号存成 %28/%29，直接写括号会让
  // 远程指示器和已保存的窗口状态里出现 `10.68.0.1%28zhuyuan%29`。
  assert.equal(uri, 'safs://10.68.0.1_zhuyuan/home/zhuyuan?mount=10.68.0.1(zhuyuan)');
  assert.equal(uri.includes('%28'), false);
  assert.deepEqual(parseRemoteUri(uri), {
    mountName: '10.68.0.1(zhuyuan)',
    remotePath: '/home/zhuyuan'
  });
  // VS Code 已经把括号编码进 authority 的旧 URI（没有 ?mount=）也要能解析。
  assert.deepEqual(parseRemoteUri('safs://10.44.9.4%28zhuyuan%29/home/julyan'), {
    mountName: '10.44.9.4(zhuyuan)',
    remotePath: '/home/julyan'
  });
  // 重名时追加的 `#` 不是安全字符：仍退回十六进制 authority，解析无损。
  const duplicate = remoteUri('10.68.0.1(zhuyuan)#2', '/home');
  assert.match(duplicate, /^safs:\/\/m-[0-9a-f]+\//);
  assert.equal(parseRemoteUri(duplicate).mountName, '10.68.0.1(zhuyuan)#2');
  // 非 ASCII 账号逐字符转义，原名走 query。
  const unicodeUser = remoteUri('10.68.0.1(朱远)', '/home');
  assert.match(unicodeUser, /^safs:\/\/10\.68\.0\.1__u6731_u8fdc\//);
  assert.equal(parseRemoteUri(unicodeUser).mountName, '10.68.0.1(朱远)');
});

test('resolves legacy config names so renamed mounts keep their open windows', () => {
  setMountAliasResolver((name) => (name === 'zhuyuan_ls' ? '10.44.9.4(zhuyuan)' : name));
  try {
    assert.equal(
      parseRemoteUri('safs://zhuyuan_ls/home/julyan').mountName,
      '10.44.9.4(zhuyuan)'
    );
    // 旧名字同样可能带着 ?mount= 或转义形式，解析后都落到当前配置名。
    assert.equal(parseRemoteUri(remoteUri('zhuyuan_ls', '/home')).mountName, '10.44.9.4(zhuyuan)');
    assert.equal(parseRemoteUri('safs://other/home').mountName, 'other');
  } finally {
    setMountAliasResolver((name) => name);
  }
});

test('recovers the mount name when VS Code escapes the ?mount query', () => {
  // VS Code 保存工作区时会把 query 里的 `=` 转义成 `%3D`（旧实现里
  // `?mount=host@user` 就变成了 `?mount%3Dhost@user`），此时必须靠 authority 还原。
  const mangled = 'safs://10.68.0.1_zhuyuan/home/x?mount%3D10.68.0.1(zhuyuan)';
  assert.equal(new URL(mangled).searchParams.get('mount'), null);
  assert.equal(mountAuthorityAlias('10.68.0.1(zhuyuan)'), '10.68.0.1_zhuyuan');
  assert.equal(mountAuthorityAlias('gkn'), undefined);
  setMountAliasResolver((name) =>
    (name === '10.68.0.1_zhuyuan' ? '10.68.0.1(zhuyuan)' : name));
  try {
    assert.equal(parseRemoteUri(mangled).mountName, '10.68.0.1(zhuyuan)');
  } finally {
    setMountAliasResolver((name) => name);
  }
  // 没有登记别名时退回 authority 本身，至少不会抛错。
  assert.equal(parseRemoteUri(mangled).mountName, '10.68.0.1_zhuyuan');
});

test('uses the config name as the authority when it is URI-safe', () => {
  const uri = remoteUri('gkn', '/home/alice');
  assert.equal(uri, 'safs://gkn/home/alice');
  assert.deepEqual(parseRemoteUri(uri), {
    mountName: 'gkn',
    remotePath: '/home/alice'
  });
  const hierarchical = remoteUri('10.68.0.3@nsgsx_zyc', '/home/zhuyuan');
  assert.equal(
    hierarchical,
    'safs://10.68.0.3_nsgsx_zyc/home/zhuyuan?mount=10.68.0.3%40nsgsx_zyc'
  );
  assert.deepEqual(parseRemoteUri(hierarchical), {
    mountName: '10.68.0.3@nsgsx_zyc',
    remotePath: '/home/zhuyuan'
  });
  const unicodeHost = remoteUri('zhuyuan_测试主机', '/home/zhuyuan');
  assert.equal(unicodeHost.includes('m-'), false);
  assert.match(unicodeHost, /^safs:\/\/zhuyuan__u6d4b_u8bd5_u4e3b_u673a\//);
  assert.deepEqual(parseRemoteUri(unicodeHost), {
    mountName: 'zhuyuan_测试主机',
    remotePath: '/home/zhuyuan'
  });
  // Unsafe names (uppercase/space) fall back to the legacy hex authority.
  const hex = remoteUri('My Host', '/home');
  assert.match(hex, /^safs:\/\/m-[0-9a-f]+\//);
  assert.deepEqual(parseRemoteUri(hex), { mountName: 'My Host', remotePath: '/home' });
  // Legacy hex authorities still decode (backward compatibility).
  assert.equal(parseRemoteUri('safs://m-676b6e/home/alice').mountName, 'gkn');
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
