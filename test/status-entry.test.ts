import assert from 'node:assert/strict';
import test from 'node:test';
import { describeStatusEntry } from '../src/ui/status-entry';

test('the status entry prioritizes sync, Git and then the active transport', () => {
  const input = {
    gitAvailable: true,
    gitTooltip: 'main',
    transport: () => assert.fail('queried transport while showing sync or Git'),
    describeHost: () => assert.fail('queried host while showing sync or Git')
  };
  assert.deepEqual(describeStatusEntry({ ...input, sync: { remotePath: '/remote', localDir: '/local' } }),
    { text: '$(sync) SAFS SYNC', tooltip: '双向同步已开启：/remote ↔ /local' });
  assert.deepEqual(describeStatusEntry(input), { text: '$(git-branch) SAFS Git', tooltip: 'main' });
  for (const transport of ['sftp', 'scp'] as const) {
    assert.deepEqual(describeStatusEntry({
      gitAvailable: false, transport: () => transport, describeHost: () => '主机：dev'
    }), {
      text: `$(remote) SAFS ${transport.toUpperCase()}`,
      tooltip: `传输通道：${transport.toUpperCase()}（ssh2）\n主机：dev`
    });
  }
  assert.equal(describeStatusEntry({ ...input, gitAvailable: false, transport: () => undefined }), undefined);
});
