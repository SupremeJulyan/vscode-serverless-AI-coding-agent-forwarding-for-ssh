import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { remoteSnapshotDiffCommand, remoteSnapshotRestoreCommand, saveRemoteSnapshot } from '../src/remote/remote-snapshot'

const execute = promisify(execFile)

test('keeps the three newest snapshots per path and reports retired IDs', {skip:process.platform !== 'linux'}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'safs-snapshot-retention-'))
  t.after(() => rm(home, {recursive:true, force:true}))
  const root = await mkdtemp(join(home, 'workspace-'))
  const run = (command: string) => execute('sh', ['-c', command], {env:{...process.env, HOME:home}})
  const file = join(root, 'notes.txt')
  const other = join(root, 'other.txt')
  const unrelated = await saveRemoteSnapshot(run, root, 'remote_write', [other])
  const ids: string[] = [], expired: string[] = []
  for (let index = 0; index < 4; index++) {
    await writeFile(file, String(index))
    ids.push(await saveRemoteSnapshot(run, root, 'remote_write', [file], false, removed => expired.push(...removed)))
  }
  assert.deepEqual(expired, [ids[0]])
  await assert.rejects(run(remoteSnapshotDiffCommand(root, ids[0])))
  for (const id of [...ids.slice(1), unrelated]) await run(remoteSnapshotDiffCommand(root, id))
})

test('clean tracked files reuse pinned blobs while dirty, ignored and filtered bytes use archives', {skip:process.platform !== 'linux'}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'safs-git-reuse-'))
  t.after(() => rm(home, {recursive:true, force:true}))
  const root = await mkdtemp(join(home, 'workspace-'))
  const env = {...process.env, HOME:home}
  const run = (command: string) => execute('sh', ['-c', command], {env})
  const git = (...args: string[]) => execute('git', ['-C', root, ...args], {env})
  const repo = join(home, '.safs-snapshots', createHash('sha256').update(root).digest('hex') + '.git')
  const snapshotGit = (...args: string[]) => execute('git', ['--git-dir', repo, ...args], {env})
  const ref = (id: string) => 'refs/safs/snapshots/' + id
  const nested = join(root, 'nested')
  const file = join(nested, 'tracked.txt')
  const filtered = join(root, 'filtered.txt')
  const ignored = join(root, 'ignored.txt')
  await git('init', '-q')
  await mkdir(nested)
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n')
  await writeFile(join(root, '.gitattributes'), 'filtered.txt text eol=crlf\n')
  await writeFile(file, 'base\n')
  await writeFile(filtered, 'line\r\n')
  await writeFile(ignored, 'private\n')
  await git('add', '.')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'base')
  await chmod(file, 0o640)
  const before = await saveRemoteSnapshot(run, root, 'remote_write', [file], true)
  const manifest = JSON.parse((await snapshotGit('show', ref(before) + ':manifest.json')).stdout)
  assert.equal(manifest.gitReference.mode, 0o640)
  assert.equal((await git('rev-parse', ref(before))).stdout.trim(), manifest.gitReference.oid)
  await assert.rejects(snapshotGit('cat-file', '-e', ref(before) + ':files.tar'))

  await writeFile(file, 'dirty\n')
  for (const target of [file, filtered, ignored]) {
    const id = await saveRemoteSnapshot(run, root, 'remote_write', [target], true)
    await snapshotGit('cat-file', '-e', ref(id) + ':files.tar')
  }
  await git('add', 'nested/tracked.txt')
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'next')
  assert.match((await run(remoteSnapshotDiffCommand(root, before))).stdout, /^-base$/m)
  await run(remoteSnapshotRestoreCommand(root, before))
  assert.equal(await readFile(file, 'utf8'), 'base\n')
  assert.equal((await stat(file)).mode & 0o777, 0o640)
})

test('snapshot diff reads current files and restore replaces later edits', {skip:process.platform !== 'linux'}, async t => {
  const home = await mkdtemp(join(tmpdir(), 'safs-snapshot-test-'))
  t.after(() => rm(home, {recursive:true, force:true}))
  const root = await mkdtemp(join(home, 'workspace-'))
  const run = (command: string) => execute('sh', ['-c', command], {env:{...process.env, HOME:home}})
  const file = join(root, 'notes.txt')
  const moved = join(root, 'moved.txt')
  await writeFile(file, 'before\n')
  const before = await saveRemoteSnapshot(run, root, 'remote_write', [file])
  await writeFile(file, 'after\n')
  const restore = remoteSnapshotRestoreCommand(root, before)
  await writeFile(file, 'manual edit\n')
  const diff = await run(remoteSnapshotDiffCommand(root, before))
  assert.match(diff.stdout, /^-before$/m)
  assert.match(diff.stdout, /^\+manual edit$/m)
  await run(restore)
  assert.equal(await readFile(file, 'utf8'), 'before\n')

  const beforeMove = await saveRemoteSnapshot(run, root, 'remote_move', [file, moved])
  await rename(file, moved)
  await run(remoteSnapshotRestoreCommand(root, beforeMove))
  assert.equal(await readFile(file, 'utf8'), 'before\n')
  await assert.rejects(readFile(moved), {code:'ENOENT'})

  const dir = join(root, 'empty')
  await mkdir(dir)
  const deleted = await saveRemoteSnapshot(run, root, 'remote_delete', [file, dir])
  await rm(file)
  await rm(dir, {recursive:true})
  await writeFile(file, 'recreated later\n')
  await run(remoteSnapshotRestoreCommand(root, deleted))
  assert.equal(await readFile(file, 'utf8'), 'before\n')
})

