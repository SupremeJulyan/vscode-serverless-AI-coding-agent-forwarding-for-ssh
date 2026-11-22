import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { shellQuote } from '../shared/shell-quote';

type Run = (command: string) => Promise<unknown>;

const materializeScript = String.raw`
def materialize(repo, snapshot, destination):
    def blob(name):
        return 'refs/safs/snapshots/' + snapshot + ':' + name
    command = ['git', '--git-dir', str(repo), 'cat-file', 'blob']
    metadata = json.loads(subprocess.check_output(command + [blob('manifest.json')]))
    reference = metadata.get('gitReference')
    if reference:
        path = Path(destination) / reference['path']
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open('xb') as output:
            subprocess.run(['git', '--git-dir', reference['gitDir'], 'cat-file', 'blob', reference['oid']],
                           stdout=output, check=True, env=dict(os.environ, GIT_ALLOW_PROTOCOL=''))
        if path.stat().st_gid != reference['gid']:
            os.chown(path, -1, reference['gid'])
        os.chmod(path, reference['mode'])
        os.utime(path, ns=(reference['mtime'], reference['mtime']))
    else:
        with tempfile.TemporaryFile() as archive:
            subprocess.run(command + [blob('files.tar')], stdout=archive, check=True)
            archive.seek(0)
            subprocess.run(['tar', '-xpf', '-', '-C', str(destination), '--no-same-owner'],
                           stdin=archive, check=True)
`;

const reuseScript = String.raw`
import json, os, stat, subprocess, sys
from pathlib import Path
repo, manifest, snapshot, root = sys.argv[1:]
os.environ['GIT_NO_LAZY_FETCH'] = '1'
os.environ['GIT_ALLOW_PROTOCOL'] = ''
metadata = json.loads(manifest)
paths = metadata['paths']
root = Path(root)
if any((root / p).resolve() != root / p for p in paths):
    sys.exit(1)
present = [p for p in paths if os.path.lexists(root / p)]
if len(present) != 1:
    sys.exit(1)
target = root / present[0]
def project(*args):
    return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(target.parent), *args],
                                   stderr=subprocess.DEVNULL).rstrip(b'\n')
try:
    initial = target.lstat()
    if (not stat.S_ISREG(initial.st_mode) or initial.st_uid != os.geteuid()
        or initial.st_gid != os.getegid() or initial.st_nlink != 1
        or initial.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX)
        or os.listxattr(target, follow_symlinks=False)):
        sys.exit(1)
    top = Path(os.fsdecode(project('rev-parse', '--show-toplevel')))
    gitdir = os.fsdecode(project('rev-parse', '--absolute-git-dir'))
    relative = target.relative_to(top).as_posix()
    oid = project('rev-parse', '--verify', 'HEAD:' + relative).decode('ascii')
    if project('cat-file', '-t', oid) != b'blob':
        sys.exit(1)
    mode = project('ls-tree', '--full-tree', 'HEAD', '--', ':(literal)' + relative).split(b' ', 1)[0]
    if mode not in (b'100644', b'100755'):
        sys.exit(1)
    if project('hash-object', '--no-filters', '--', str(target)).decode('ascii') != oid:
        sys.exit(1)
    current = target.lstat()
    if (current.st_dev, current.st_ino, current.st_ctime_ns) != (initial.st_dev, initial.st_ino, initial.st_ctime_ns):
        sys.exit(1)
    project('update-ref', 'refs/safs/snapshots/' + snapshot, oid)
except (OSError, ValueError, subprocess.CalledProcessError):
    sys.exit(1)
metadata['gitReference'] = dict(gitDir=gitdir, oid=oid, path=present[0], mode=stat.S_IMODE(initial.st_mode),
                                gid=initial.st_gid, mtime=initial.st_mtime_ns)
try:
    git = ['git', '--git-dir', repo]
    manifest_oid = subprocess.check_output(git + ['hash-object', '-w', '--stdin'], input=json.dumps(metadata).encode()).strip()
    tree = subprocess.check_output(git + ['mktree'], input=b'100644 blob ' + manifest_oid + b'\tmanifest.json\n').strip()
    subprocess.run(git + ['update-ref', 'refs/safs/snapshots/' + snapshot, tree.decode()], check=True)
except (OSError, subprocess.CalledProcessError):
    project('update-ref', '-d', 'refs/safs/snapshots/' + snapshot, oid)
    sys.exit(1)
`;

const restoreScript = String.raw`
import json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
` + materializeScript + String.raw`

root, key, before = sys.argv[1:]
root = Path(root)
repo = Path.home() / '.safs-snapshots' / (key + '.git')
def git(*args, **kwargs):
    return subprocess.check_output(['git', '--git-dir', str(repo), *args], **kwargs)
def ref(snapshot, name):
    return 'refs/safs/snapshots/' + snapshot + ':' + name
paths = json.loads(git('cat-file', 'blob', ref(before, 'manifest.json')))['paths']
if not paths or any(Path(p).is_absolute() or '..' in Path(p).parts or p in ('', '.') for p in paths):
    raise SystemExit('Invalid snapshot paths')
if any(a != b and b.startswith(a + '/') for a in paths for b in paths):
    raise SystemExit('Overlapping snapshot paths cannot be restored')
paths = list(dict.fromkeys(paths))

def validate():
    for p in paths:
        target = root / p
        if target.resolve() != target or target.is_symlink() or not target.parent.is_dir():
            raise RuntimeError('The target path or its parent changed: ' + p)

validate()
stage = Path(tempfile.mkdtemp(prefix='.safs-restore-', dir=root))
saved = []
published = []
keep = False
try:
    original = stage / 'original'
    original.mkdir()
    materialize(repo, before, original)
    validate()
    for index, p in enumerate(paths):
        target = root / p
        if os.path.lexists(target):
            backup = stage / str(index)
            os.rename(target, backup)
            saved.append((backup, target))
    for p in paths:
        source, target = original / p, root / p
        if os.path.lexists(source):
            if os.path.lexists(target):
                raise RuntimeError('A path appeared during restore: ' + p)
            os.rename(source, target)
            published.append((source, target))
except BaseException:
    try:
        for source, target in reversed(published):
            os.rename(target, source)
        for backup, target in reversed(saved):
            if os.path.lexists(target):
                raise RuntimeError('Path occupied during rollback: ' + str(target))
            os.rename(backup, target)
    except BaseException:
        keep = True
        print('Restore interrupted. Recovery files: ' + str(stage), file=sys.stderr)
    raise
finally:
    if not keep:
        shutil.rmtree(stage)
`;

const pruneScript = String.raw`
import fcntl, json, os, subprocess, sys
from collections import Counter
from pathlib import Path

repo, current = sys.argv[1:]
prefix = 'refs/safs/snapshots/'
git = ['git', '--git-dir', repo]
os.environ['GIT_ALLOW_PROTOCOL'] = ''
with (Path(repo) / 'safs-retention.lock').open('ab') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    snapshots = []
    for ref in subprocess.check_output(git + ['for-each-ref', '--format=%(refname)', prefix]).decode().splitlines():
        manifest = json.loads(subprocess.check_output(git + ['cat-file', 'blob', ref + ':manifest.json']))
        snapshots.append((manifest['createdAt'], ref, manifest))
    counts = Counter()
    expired = []
    for _, ref, manifest in sorted(snapshots, key=lambda item: (item[0], item[1] == prefix + current, item[1]), reverse=True):
        paths = set(manifest['paths'])
        if any(counts[path] >= 3 for path in paths):
            expired.append((ref, manifest.get('gitReference')))
        counts.update(paths)
    for ref, reference in expired:
        subprocess.run(git + ['update-ref', '-d', ref], check=True)
        print(ref[len(prefix):], flush=True)
        if reference:
            subprocess.run(['git', '--git-dir', reference['gitDir'], 'update-ref', '-d', ref, reference['oid']], check=False)
`;

export function remoteSnapshotRestoreCommand(root: string, before: string): string {
  if (!/^[0-9a-f-]{36}$/.test(before)) {
    throw new Error('Invalid snapshot ID');
  }
  const key = createHash('sha256').update(root).digest('hex');
  return ['python3', '-c', restoreScript, root, key, before].map(shellQuote).join(' ');
}

export function remoteSnapshotDiffCommand(root: string, before: string): string {
  if (!/^[0-9a-f-]{36}$/.test(before)) throw new Error('Invalid snapshot ID');
  const key = createHash('sha256').update(root).digest('hex');
  return [
    '(',
    'set -eu',
    'umask 077',
    `repo="$HOME/.safs-snapshots/${key}.git"`,
    'scratch=$(mktemp -d "$HOME/.safs-snapshots/.diff.XXXXXXXX")',
    'trap \'rm -rf -- "$scratch"\' EXIT',
    'cd -- "$scratch"',
    'mkdir before current',
    `python3 -c ${shellQuote(liveArchiveScript)} ${shellQuote(root)} "$repo" ${shellQuote(before)}`,
    'tar --extract --file=current.tar --directory=current --no-same-owner --no-same-permissions',
    'status=0',
    'git --no-pager diff --no-index --no-ext-diff --no-textconv -- before current || status=$?',
    'test "$status" -le 1',
    ')',
  ].join('\n');
}

export function remoteSnapshotTextPairCommand(root: string, before: string): string {
  if (!/^[0-9a-f-]{36}$/.test(before)) throw new Error('Invalid snapshot ID');
  const key = createHash('sha256').update(root).digest('hex');
  const script = String.raw`
import json, os, subprocess, sys, tempfile
from pathlib import Path
` + materializeScript + String.raw`
root, key, snapshot = sys.argv[1:]
root = Path(root)
repo = Path.home() / '.safs-snapshots' / (key + '.git')
ref = 'refs/safs/snapshots/' + snapshot
paths = json.loads(subprocess.check_output(['git', '--git-dir', str(repo), 'cat-file', 'blob', ref + ':manifest.json']))['paths']
if len(paths) != 1:
    print('null')
    sys.exit(0)
relative = Path(paths[0])
target = root / relative
if relative.is_absolute() or '..' in relative.parts or not relative.parts or target.resolve() != target:
    raise SystemExit('Invalid snapshot target')
def text(file):
    if not file.exists():
        return ''
    if not file.is_file() or file.is_symlink() or file.stat().st_size > 128 * 1024:
        raise ValueError('Not a small text file')
    data = file.read_bytes()
    if b'\0' in data:
        raise ValueError('Not a text file')
    return data.decode('utf-8')
with tempfile.TemporaryDirectory() as directory:
    materialize(repo, snapshot, directory)
    try:
        print(json.dumps(dict(path=paths[0], before=text(Path(directory) / relative), current=text(target)), ensure_ascii=False))
    except ValueError:
        print('null')
`;
  return ['python3', '-c', script, root, key, before].map(shellQuote).join(' ');
}

const liveArchiveScript = String.raw`
import json, os, subprocess, sys, tempfile
from pathlib import Path
` + materializeScript + String.raw`

root = Path(sys.argv[1])
repo, snapshot = sys.argv[2:]
materialize(repo, snapshot, 'before')
paths = json.loads(subprocess.check_output(['git', '--git-dir', repo, 'cat-file', 'blob',
    'refs/safs/snapshots/' + snapshot + ':manifest.json']))['paths']
present = []
for p in dict.fromkeys(paths):
    relative = Path(p)
    target = root / relative
    if relative.is_absolute() or '..' in relative.parts or p in ('', '.') or target.parent.resolve() != target.parent:
        raise SystemExit('Snapshot path or its parent changed: ' + p)
    if os.path.lexists(target):
        present.append(os.fsencode(p) + b'\0')
with open('current.tar', 'wb') as archive:
    subprocess.run(['tar', '--create', '--file=-', '--null', '--files-from=-'],
                   cwd=root, input=b''.join(present), stdout=archive, check=True)
`;

/** Store exact file bytes and metadata without using the project's Git index. */
export async function saveRemoteSnapshot(run: Run, root: string, operation: string, targets: string[], reuseGit = false, onExpired?: (ids: string[]) => void): Promise<string> {
  const snapshotId = randomUUID();
  const workspaceKey = createHash('sha256').update(root).digest('hex');
  const paths = [...new Set(targets)].map(target => posix.relative(root, target));
  if (paths.some(path => !path || path === '..' || path.startsWith('../'))) {
    throw new Error('Snapshot paths must be inside the workspace');
  }
  const manifest = JSON.stringify({ version: 1, snapshotId, operation, paths, createdAt: new Date().toISOString() });
  const command = [
    '(',
    'set -eu',
    'umask 077',
    'base="$HOME/.safs-snapshots"',
    'command -v python3 >/dev/null',
    'test ! -L "$base"',
    'mkdir -p -- "$base"',
    'base=$(cd -P -- "$base" && pwd -P)',
    `root=${shellQuote(root)}`,
    'case "$base/" in "$root/"*|"$root") echo "Snapshot storage overlaps the workspace" >&2; exit 1;; esac',
    `repo="$base/${workspaceKey}.git"`,
    'test ! -L "$repo"',
    'if test ! -f "$repo/HEAD"; then git init --quiet --bare "$repo"; fi',
    `prune() { python3 -c ${shellQuote(pruneScript)} "$repo" ${shellQuote(snapshotId)}; }`,
    ...(reuseGit ? [
      `if command -v python3 >/dev/null && python3 -c ${shellQuote(reuseScript)} "$repo" ${shellQuote(manifest)} ${shellQuote(snapshotId)} ${shellQuote(root)}; then prune; exit 0; fi`,
    ] : []),
    'scratch=$(mktemp -d "$base/.snapshot.XXXXXXXX")',
    'trap \'rm -rf -- "$scratch"\' EXIT',
    `set -- ${paths.map(shellQuote).join(' ')}`,
    'cd -- "$root"',
    'for path do',
    '  test "$(realpath -m -- "$path")" = "$root/$path"',
    '  if test -e "$path" || test -L "$path"; then',
    '    printf "%s\\000" "$path" >> "$scratch/present"',
    '  fi',
    'done',
    'touch "$scratch/present"',
    'tar --create --file="$scratch/files.tar" --null --files-from="$scratch/present"',
    `manifest=$(printf "%s" ${shellQuote(manifest)} | git --git-dir="$repo" hash-object -w --stdin)`,
    'archive=$(git --git-dir="$repo" hash-object -w --no-filters "$scratch/files.tar")',
    'tree=$(printf "100644 blob %s\\tmanifest.json\\n100644 blob %s\\tfiles.tar\\n" "$manifest" "$archive" | git --git-dir="$repo" mktree)',
    `git --git-dir="$repo" update-ref refs/safs/snapshots/${snapshotId} "$tree"`,
    'prune',
    ')',
  ].join('\n');
  try {
    const result = await run(command) as { stdout?: string } | undefined;
    const expired = (result?.stdout ?? '').split(/\r?\n/).filter(id => /^[0-9a-f-]{36}$/.test(id));
    if (expired.length) onExpired?.(expired);
  } catch (error) {
    throw new Error('Remote snapshot failed. The file operation did not start.', { cause: error });
  }
  return snapshotId;
}

