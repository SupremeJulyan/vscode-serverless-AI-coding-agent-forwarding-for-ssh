import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { testLoopbackProxy } from '../src/proxy-diagnostic';

test('diagnostic verifies direct access, proxy interception and NO_PROXY bypass', async () => {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/_proxy$/i.test(key)));
  const direct = await testLoopbackProxy(clean);
  assert.equal(direct.length, 3);
  assert.equal(direct.find((entry) => entry.host === '127.0.0.1')?.reachable, true);
  let requests = 0;
  const proxy = createServer((_request, response) => {
    requests++;
    response.writeHead(502, { Connection: 'close' });
    response.end('blocked');
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const address = proxy.address();
    assert.ok(address && typeof address !== 'string');
    const env = { ...clean, HTTP_PROXY: `http://127.0.0.1:${address.port}` };
    const blocked = await testLoopbackProxy(env);
    assert.ok(requests > 0);
    for (const result of blocked.filter((entry) => !entry.unavailable)) {
      assert.equal(result.reachable, false);
      assert.notEqual(result.proxyUsed, false);
    }
    requests = 0;
    const bypassed = await testLoopbackProxy({ ...env, NO_PROXY: 'localhost,127.0.0.1,::1' });
    assert.equal(requests, 0);
    assert.equal(bypassed.find((entry) => entry.host === '127.0.0.1')?.reachable, true);
  } finally {
    proxy.closeAllConnections();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});
