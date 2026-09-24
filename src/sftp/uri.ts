import * as path from 'node:path';

export const remoteFileSystemScheme = 'safs';

export interface RemoteUriLocation {
  mountName: string;
  remotePath: string;
}

function encodeMountAuthority(mountName: string): string {
  if (!mountName) throw new Error('Remote folder name must not be empty');
  // URI authorities are case-insensitive and URL parsers normalize hostnames
  // to lowercase. Use the plain mount name when it already is a safe,
  // lowercase authority so VS Code shows the config name directly in the
  // status-bar/remote indicator; fall back to lowercase hexadecimal for
  // anything else so the identifier survives that normalization.
  // `m-<hex>` 是历史遗留的十六进制形式：明文名字长得像它的话解析时会被当成旧格式解出
  // 另一个名字（且这种 URI 不带 ?mount= 兜底），所以强制走转义/十六进制分支。
  const looksLikeLegacyHex = /^m-[0-9a-f]+$/.test(mountName) && mountName.length % 2 === 0;
  // 长得像旧十六进制形式的名字只能走十六进制兜底，否则解析时会被解成别的名字。
  if (looksLikeLegacyHex) return `m-${Buffer.from(mountName, 'utf8').toString('hex')}`;
  if (/^[a-z0-9][a-z0-9._-]*$/.test(mountName)) return mountName;
  // Legacy hierarchical names were generated as "host@user"; configuration names
  // are "host(account)" (alias or IP + account). Keep the authority readable and ASCII-only in
  // VS Code's remote indicator, including Unicode host aliases; the original
  // name is carried in the URI query so parsing remains lossless.
  // Parentheses must be escaped here: VS Code percent-encodes them inside an
  // authority (`%28`), which would then leak into the remote indicator and the
  // stored window state instead of showing the configuration name.
  if (/^[\p{L}\p{N}][\p{L}\p{N}._@()-]*$/u.test(mountName)
      && !/[A-Z]/.test(mountName)) {
    return escapeMountAuthority(mountName);
  }
  return `m-${Buffer.from(mountName, 'utf8').toString('hex')}`;
}

/**
 * 可读转义：`主机名(账号)` → `主机名_账号`。
 *
 * 必须是**单射**的：VS Code 会把 URI 里的 `?mount=` 的 `=` 转义成 `%3D`，存下来的
 * URI 只剩 authority 可用，两个不同的配置名映射到同一个 authority 就会静默打开错主机
 * （例如 `devbox(alice_k)` 与 `devbox_alice(k)` 这种只差括号/下划线位置的组合）。所以下划线自身要转义成 `__`。
 */
function escapeMountAuthority(mountName: string): string {
  return [...mountName].map((character) => {
    if (/^[a-z0-9.-]$/.test(character)) return character;
    if (character === '_') return '__';
    // 括号在 authority 里不能出现：左括号写成 `_`，右括号去掉（生成的名字总是成对）。
    if (character === '(') return '_';
    if (character === ')') return '';
    // `@` 只是历史命名（`host@user`）里的分隔符：写成 `_` 仍然单射，因为字面下划线
    // 已经被写成 `__`。
    if (character === '@') return '_';
    return `_u${character.codePointAt(0)!.toString(16)}`;
  }).join('');
}

/**
 * 上一版（非单射）的转义形式：`_` 原样、`@` → `_`、括号写成 `_`/``。
 *
 * 已经存进 VS Code 窗口状态的 URI 用的是这种形式，改名/升级后仍要能解析出来。
 */
export function legacyMountAuthorityAlias(mountName: string): string | undefined {
  if (!mountName) return undefined;
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._@()-]*$/u.test(mountName) || /[A-Z]/.test(mountName)) {
    return undefined;
  }
  const legacy = [...mountName].map((character) => {
    if (/^[a-z0-9._-]$/.test(character)) return character;
    if (character === '@') return '_';
    if (character === '(') return '_';
    if (character === ')') return '';
    return `_u${character.codePointAt(0)!.toString(16)}`;
  }).join('');
  return legacy === mountName ? undefined : legacy;
}

/**
 * 旧配置名 → 当前配置名。配置改名后，已经保存的窗口/标签页 URI 仍然带着旧名字，
 * 由扩展在启动时注入这张映射表，解析时直接换成当前名字。
 */
let resolveMountAlias: (mountName: string) => string = (mountName) => mountName;

export function setMountAliasResolver(resolver: (mountName: string) => string): void {
  resolveMountAlias = resolver;
}

/** VS Code 会把 authority 里的 `(`、`)` 等字符百分号转义（`%28`），解析时还原。 */
function decodeAuthority(authority: string): string {
  try {
    return decodeURIComponent(authority);
  } catch {
    return authority;
  }
}

function decodeMountAuthority(authority: string): string {
  if (authority.startsWith('m-')) {
    const encoded = authority.slice(2);
    if (encoded && encoded.length % 2 === 0 && /^[0-9a-f]+$/.test(encoded)) {
      // Legacy format: lowercase-hex encoded mount name. All URIs created
      // before the plain-name change use this form, so decode it
      // unconditionally (a plain mount literally named "m-<hex>" is
      // pathological and out of scope).
      return Buffer.from(encoded, 'hex').toString('utf8');
    }
  }
  return authority;
}

export function normalizeRemotePath(remotePath: string): string {
  if (!remotePath.startsWith('/')) {
    throw new Error(`Remote URI paths must be absolute: ${remotePath}`);
  }
  return path.posix.normalize(remotePath);
}

/**
 * Validate one filename returned by a remote directory listing before it is
 * joined to either a remote or local parent. SFTP servers control this string;
 * a malicious implementation may return separators even though POSIX
 * filenames cannot contain '/'. Backslashes are rejected as well because they
 * become separators when the same name is materialized on Windows.
 */
export function assertSafeRemoteEntryName(name: string): void {
  if (!name || name === '.' || name === '..' || /[\0/\\]/.test(name)) {
    throw new Error(`Unsafe remote directory entry name: ${JSON.stringify(name)}`);
  }
}

function encodeRemotePath(remotePath: string): string {
  return normalizeRemotePath(remotePath)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function decodeRemotePath(pathname: string): string {
  try {
    return normalizeRemotePath(
      pathname.split('/').map((segment) => decodeURIComponent(segment)).join('/')
    );
  } catch (error) {
    if (error instanceof URIError) throw new Error(`Invalid remote URI path: ${pathname}`);
    throw error;
  }
}

/**
 * Produces a URI safe for use as a VS Code workspace folder. The authority is
 * an opaque, reversible mount identifier so names containing spaces, Unicode,
 * or host-like punctuation do not leak into URI parsing rules.
 */
export function remoteUri(mountName: string, remotePath: string): string {
  const authority = encodeMountAuthority(mountName);
  const query = authority === mountName && !/[^\x00-\x7f]/.test(mountName)
    ? '' : `?mount=${encodeURIComponent(mountName)}`;
  return `${remoteFileSystemScheme}://${authority}${encodeRemotePath(remotePath)}${query}`;
}

/**
 * 名字对应的 authority（只有在与名字不同的时候才有值）。
 *
 * VS Code 保存工作区/标签页时会把 query 里的 `=` 转义成 `%3D`（旧实现里
 * `?mount=host@user` 就变成了 `?mount%3Dhost@user`，解析时取不到），因此
 * authority 本身必须是可还原的：调用方用它登记「authority → 当前配置名」，
 * 即使 `?mount=` 丢了也能找回正确名字。
 */
export function mountAuthorityAlias(mountName: string): string | undefined {
  const authority = encodeMountAuthority(mountName);
  return authority === mountName ? undefined : authority;
}

export function parseRemoteUri(value: string): RemoteUriLocation {
  const parsed = new URL(value);
  if (parsed.protocol !== `${remoteFileSystemScheme}:`) {
    throw new Error(`Unsupported remote URI scheme: ${parsed.protocol.slice(0, -1)}`);
  }
  // VS Code media previews append cache-busting query/fragment data to custom
  // filesystem URIs. They are not part of the remote filename and must be
  // ignored, just like FileSystemProvider implementations ignore URI metadata.
  if (parsed.username || parsed.password || parsed.port) {
    throw new Error(`Invalid remote workspace URI: ${value}`);
  }
  const queryMountName = parsed.searchParams.get('mount');
  // `?mount=` 仅供参考：VS Code 可能把其中的 `=` 转义成 `%3D` 而取不到，所以
  // authority 必须是可还原的（十六进制，或由扩展登记过的转义形式）。
  const authorityName = decodeMountAuthority(decodeAuthority(parsed.hostname));
  return {
    // 别名解析放在最后：旧名字/转义 authority 的 URI 也落到当前配置上。
    mountName: resolveMountAlias(queryMountName || authorityName),
    remotePath: decodeRemotePath(parsed.pathname)
  };
}

export function isRemotePathInsideRoot(remoteRoot: string, candidate: string): boolean {
  const normalizedRoot = normalizeRemotePath(remoteRoot);
  const normalizedCandidate = normalizeRemotePath(candidate);
  const relative = path.posix.relative(normalizedRoot, normalizedCandidate);
  return relative === '' || (!relative.startsWith('../') && relative !== '..');
}

/**
 * A configured "." cannot be represented in a workspace URI until SFTP has
 * resolved the login directory. Other relative paths are likewise resolved by
 * the server through realpath before this helper is called.
 */
export function resolvedRemoteRoot(configuredPath: string, realPath: string): string {
  if (!realPath.startsWith('/')) {
    throw new Error(`SFTP realpath must return an absolute path: ${realPath}`);
  }
  if (configuredPath === '.' || !configuredPath.startsWith('/')) {
    return normalizeRemotePath(realPath);
  }
  return normalizeRemotePath(configuredPath);
}
