#!/usr/bin/env node
import { callSafs, parseCliRequest } from './safs-cli-client';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(`SAFS CLI — requires SAFS_MCP_URL from the existing SAFS router configuration.
Usage:
  safs bind [--cwd LOCAL_AGENT_CWD]
  safs exec --binding ID [--cwd REMOTE_CWD] -- 'REMOTE_COMMAND'
  safs output --binding ID --id OUTPUT_ID --stream stdout|stderr [--offset N] [--length N]

Bind once and reuse the returned bindingId. Candidate lists require user selection
through the existing MCP workspace-switch flow; the CLI never picks a candidate.
Exec writes remote stdout/stderr directly and preserves the remote exit code.
Truncated output includes continuation metadata on stderr; output returns JSON.
No SSH credentials or remote service installation are needed by this wrapper.
`);
    return;
  }
  const request = parseCliRequest(args, process.cwd());
  const url = process.env.SAFS_MCP_URL;
  if (!url) throw new Error('Set SAFS_MCP_URL to the existing SAFS router URL.');
  const result = await callSafs(url, request);
  if (request.name !== 'run_remote_command') {
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }
  if (typeof result.stdout === 'string') process.stdout.write(result.stdout);
  if (typeof result.stderr === 'string') process.stderr.write(result.stderr);
  if (result.truncated) {
    const { stdout: _stdout, stderr: _stderr, ...metadata } = result;
    process.stderr.write('\n' + JSON.stringify({ safsOutput: metadata }) + '\n');
  }
  process.exitCode = typeof result.exitCode === 'number' && Number.isInteger(result.exitCode)
    && result.exitCode >= 0 && result.exitCode <= 255 ? result.exitCode : 1;
}
main().catch(error => {
  let message = error instanceof Error ? error.message : String(error);
  const url = process.env.SAFS_MCP_URL;
  if (url) {
    message = message.replaceAll(url, '[SAFS URL]');
    try {
      const token = new URL(url).searchParams.get('token');
      if (token) message = message.replaceAll(token, '[redacted]').replaceAll(encodeURIComponent(token), '[redacted]');
    } catch { /* Invalid URLs are reported without echoing the environment value. */ }
  }
  process.stderr.write(`SAFS: ${message}\n`);
  process.exitCode = 1;
});
