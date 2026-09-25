import assert from 'node:assert/strict';
import * as path from 'node:path';
import test from 'node:test';
import {
  downloadPartPath, isTransferPartName, partNameFor, partSourceLabel, partToken, planResume,
  pruneTransferParts, shouldKeepPart, uploadPartName, RESUME_MIN_BYTES
} from '../src/resume-plan';

const signature = (size: number, mtimeMs = 1000) => ({ size, mtimeMs });
const TOKEN = 'abcdef0123456789';

test('part names embed the source signature so a changed source invalidates the part', () => {
  const before = partNameFor('big.bin', signature(5_000_000, 111), TOKEN);
  const sameSource = partNameFor('big.bin', signature(5_000_000, 111), TOKEN);
  const editedSource = partNameFor('big.bin', signature(5_000_000, 222), TOKEN);
  const grownSource = partNameFor('big.bin', signature(5_000_001, 111), TOKEN);
  const otherSession = partNameFor('big.bin', signature(5_000_000, 111), 'ffffffffffffffff');
  const otherName = partNameFor('other.bin', signature(5_000_000, 111), TOKEN);
  assert.equal(before, sameSource);
  for (const variant of [editedSource, grownSource, otherSession, otherName]) {
    assert.notEqual(before, variant);
  }
  // 名字里的令牌是「会话 + 名字 + 签名」的哈希，不是明文令牌本身；解析出来的
  // 只是用于机会清理的标识，不能反推出会话 token。
  assert.match(before, /^big\.bin\.safs-part-[0-9a-f]{16}$/);
  const token = partToken(before);
  assert.ok(token !== undefined && /^[0-9a-f]{16}$/.test(token));
  assert.equal(partToken(before), partToken(sameSource));
});

test('upload parts are hidden siblings of the remote target', () => {
  const part = uploadPartName('/srv/app/big.bin', signature(9));
  assert.match(part, /^\/srv\/app\/\.big\.bin\.safs-part-[0-9a-f]{16}$/);
  assert.equal(isTransferPartName(path.posix.basename(part)), true);
  assert.equal(isTransferPartName('big.bin'), false);
  assert.equal(isTransferPartName('.safs-upload-3f2a.part'), false);
  // 旧实现留下的随机名残片：认不出来，也就不会被误当成可续的残片。
  assert.equal(isTransferPartName('.safs-upload-9a1b2c3d.part'), false);
});

test('partSourceLabel strips the part suffix for logs without ambiguity', () => {
  const baseline = signature(4_000_000, 7);
  const uploaded = path.posix.basename(uploadPartName('/dest/big.bin', baseline));
  const downloaded = path.basename(downloadPartPath(path.join('out', 'big.bin'), baseline));
  assert.equal(partSourceLabel(uploaded), 'big.bin');
  assert.equal(partSourceLabel(downloaded), 'big.bin');
  assert.equal(partSourceLabel('plain.bin'), 'plain.bin');
  // 源名里本身就含 ".safs-part" 时按最后一个标记切，不切半截。
  assert.equal(partSourceLabel('a.safs-part-x.bin.safs-part-00000000deadbeef'), 'a.safs-part-x.bin');
});

test('download parts sit next to the final local target', () => {
  const target = path.join('out', 'big.bin');
  const part = downloadPartPath(target, signature(9));
  assert.equal(path.dirname(part), path.dirname(target));
  assert.match(path.basename(part), /^big\.bin\.safs-part-[0-9a-f]{16}$/);
});

/**
 * 上传风格残片：`partNameFor('big.bin', …)` 得到 `big.bin.safs-part-<hash>`，
 * 加上前导点就是 `uploadPartName` 生成的名字。`name` 传的是源文件基名（两种规则
 * planResume 都认）。
 */
function parts(name: string, baseline: { size: number; mtimeMs: number }): { name: string; partName: string } {
  return { name, partName: `.${partNameFor(name, baseline, TOKEN)}` };
}

test('resumes only when the part is a smaller prefix of the same signature', () => {
  const baseline = signature(8_000_000, 42);
  const { name, partName } = parts('big.bin', baseline);
  const decision = planResume({
    name, partName, token: TOKEN, baseline,
    // 残片自己的 size 就是续传起点；它的 mtime 与源无关（写残片会改它）。
    part: { size: RESUME_MIN_BYTES + 10, mtimeMs: 999 },
    canRange: true
  });
  assert.deepEqual(decision, { resume: true, offset: RESUME_MIN_BYTES + 10, token: TOKEN });
});

test('refuses to resume when the source signature moved on', () => {
  const name = 'big.bin';
  const baseline = signature(8_000_000, 42);
  // 源被改过之后，旧残片的名字就推导不出来了：整传。
  const staleName = partNameFor(`.${name}`, signature(8_000_000, 41), TOKEN);
  assert.deepEqual(planResume({
    name, partName: staleName, token: TOKEN, baseline,
    part: { size: 4_000_000, mtimeMs: 41 }, canRange: true
  }), { resume: false, reason: 'foreign-part' });
  // size 也变了（内容被追加）：同样对不上。
  const grownName = partNameFor(`.${name}`, signature(8_000_001, 42), TOKEN);
  assert.deepEqual(planResume({
    name, partName: grownName, token: TOKEN, baseline,
    part: { size: 4_000_000, mtimeMs: 42 }, canRange: true
  }), { resume: false, reason: 'foreign-part' });
});

test('refuses to resume a part from another session or another tool', () => {
  const name = 'big.bin';
  const baseline = signature(8_000_000, 42);
  const foreign = partNameFor(`.${name}`, baseline, 'ffffffffffffffff');
  assert.deepEqual(planResume({
    name, partName: foreign, token: TOKEN, baseline,
    part: { size: 4_000_000, mtimeMs: 42 }, canRange: true
  }), { resume: false, reason: 'foreign-part' });
  assert.deepEqual(planResume({
    name, partName: '.safs-upload-9a1b2c3d.part', token: TOKEN, baseline,
    part: { size: 4_000_000, mtimeMs: 42 }, canRange: true
  }), { resume: false, reason: 'foreign-part' });
});

test('reports why a part cannot be reused', () => {
  const baseline = signature(8_000_000, 42);
  const { name, partName } = parts('big.bin', baseline);
  const at = (size: number, canRange = true) =>
    planResume({ name, partName, token: TOKEN, baseline, part: { size, mtimeMs: 1 }, canRange });
  assert.deepEqual(planResume({
    name, partName, token: TOKEN, baseline, part: undefined, canRange: true
  }), { resume: false, reason: 'no-part' });
  assert.deepEqual(at(0), { resume: false, reason: 'part-empty' });
  assert.deepEqual(at(8_000_000), { resume: false, reason: 'part-not-smaller' });
  assert.deepEqual(at(9_000_000), { resume: false, reason: 'part-too-long' });
  assert.deepEqual(at(1024), { resume: false, reason: 'below-threshold' });
  assert.deepEqual(at(4_000_000, false), { resume: false, reason: 'no-range-support' });
  // 残片 mtime 与源相同 = 可疑（源被改成同大小同时间的内容），宁可重传。
  assert.deepEqual(planResume({
    name, partName, token: TOKEN, baseline,
    part: { size: 4_000_000, mtimeMs: baseline.mtimeMs }, canRange: true
  }), { resume: false, reason: 'source-changed' });
});

test('SCP fallback never resumes', () => {
  const baseline = signature(8_000_000, 42);
  const { name, partName } = parts('big.bin', baseline);
  assert.deepEqual(planResume({
    name, partName, token: TOKEN, baseline,
    part: { size: 4_000_000, mtimeMs: 42 }, canRange: false
  }), { resume: false, reason: 'no-range-support' });
});

test('passing a path where a file name belongs fails loudly', () => {
  // 静默返回「不可续传」会让这类调用错误一直藏到线上，只表现为「续传从来不生效」。
  const baseline = signature(8_000_000, 42);
  const { partName } = parts('big.bin', baseline);
  assert.throws(() => planResume({
    name: '/dest/.big.bin', partName, token: TOKEN, baseline,
    part: { size: 4_000_000, mtimeMs: 42 }, canRange: true
  }), /需要文件名而不是路径/);
  assert.throws(() => planResume({
    name: 'big.bin', partName: `/dest/${partName}`, token: TOKEN, baseline,
    part: { size: 4_000_000, mtimeMs: 42 }, canRange: true
  }), /需要文件名而不是路径/);
});

test('source names that themselves contain the part marker still resume', () => {
  // 源文件名里出现 ".safs-part" 时必须仍然可续：判定比的是完整名字，不做反推。
  const name = 'a.safs-part-x.bin';
  const baseline = signature(4_000_000, 7);
  const partName = partNameFor(name, baseline, TOKEN);
  assert.deepEqual(planResume({
    name, partName, token: TOKEN, baseline,
    part: { size: RESUME_MIN_BYTES, mtimeMs: 1 }, canRange: true
  }), { resume: true, offset: RESUME_MIN_BYTES, token: TOKEN });
});

test('keeps only parts large enough to be worth a second round trip', () => {
  assert.equal(shouldKeepPart(0), false);
  assert.equal(shouldKeepPart(RESUME_MIN_BYTES - 1), false);
  assert.equal(shouldKeepPart(RESUME_MIN_BYTES), true);
  assert.equal(shouldKeepPart(Number.NaN), false);
});

test('prunes stale parts without touching the current transfer or foreign files', async () => {
  const removed: string[] = [];
  const day = 24 * 60 * 60 * 1000;
  const now = Date.now();
  const count = await pruneTransferParts({
    directory: '/dest',
    keep: '/dest/.keep.bin.safs-part-00000000deadbeef',
    join: (directory, name) => `${directory}/${name}`,
    list: async () => [
      { name: '.keep.bin.safs-part-00000000deadbeef', type: 'file', mtimeMs: now - 30 * day },
      { name: '.stale.bin.safs-part-1111111122222222', type: 'file', mtimeMs: now - 8 * day },
      { name: '.fresh.bin.safs-part-2222222233333333', type: 'file', mtimeMs: now - day },
      { name: 'normal.bin', type: 'file', mtimeMs: now - 30 * day },
      { name: '.staledir.safs-part-3333333344444444', type: 'directory', mtimeMs: now - 30 * day }
    ],
    remove: async (absolute) => { removed.push(absolute); }
  });
  assert.equal(count, 1);
  assert.deepEqual(removed, ['/dest/.stale.bin.safs-part-1111111122222222']);
});

test('pruning tolerates an unreadable directory', async () => {
  const count = await pruneTransferParts({
    directory: '/nope',
    join: (directory, name) => `${directory}/${name}`,
    list: async () => { throw new Error('EACCES'); },
    remove: async () => { throw new Error('must not be called'); }
  });
  assert.equal(count, 0);
});
