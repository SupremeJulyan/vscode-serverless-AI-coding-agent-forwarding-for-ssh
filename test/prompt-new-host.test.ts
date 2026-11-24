import assert from 'node:assert/strict';
import test from 'node:test';
import { promptNewHost } from '../src/config/prompt-new-host';

test('new host setup collects connection details and authentication method without credentials', async () => {
  const prompts: Array<string | undefined> = [];
  const result = await promptNewHost([{ ip: 'existing' }], () => 'localuser', async options => {
    prompts.push(options.prompt);
    assert.notEqual(options.password, true);
    if (options.prompt === 'IP 地址或主机名') {
      assert.ok(await options.validateInput?.(' existing '));
      return 'new.example';
    }
    if (options.prompt === '端口') {
      for (const invalid of ['0', '22.5', '65536']) assert.ok(await options.validateInput?.(invalid));
      assert.equal(await options.validateInput?.('2222'), undefined);
      return '2222';
    }
    return options.value;
  }, async () => {
    prompts.push('authentication method');
    return 'publickey';
  });
  assert.deepEqual(prompts, ['主机名', 'IP 地址或主机名', '端口', '账号', 'authentication method']);
  assert.deepEqual(result, { name: 'dev', ip: 'new.example', portText: '2222', user: 'localuser', auth: 'publickey' });
});

test('cancelling host setup stops before authentication', async () => {
  assert.equal(await promptNewHost([], () => assert.fail('asked for username'), async () => undefined,
    async () => assert.fail('asked for authentication')), undefined);
});
