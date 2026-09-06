#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { callSafs, prepareCliRequest } from './safs-cli-client';

let connectionUrl: string | undefined;
async function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const configIndex = args.findIndex((arg, i) => arg === '--config' && (separator < 0 || i < separator));
  let configFile: string | undefined;
  if (configIndex >= 0) {
    if (!args[configIndex + 1]) throw new Error('--config requires a file path.');
    configFile = args.splice(configIndex, 2)[1];
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write(`SAFS CLI — use --config CONNECTION.json or SAFS_MCP_URL for the existing router.
Usage:
  safs bind [--cwd LOCAL_AGENT_CWD]
  safs exec --binding ID [--cwd REMOTE_CWD] -- 'REMOTE_COMMAND'
  safs list|read --binding ID --path PATH [--input OPTIONS.json]
  safs search --binding ID --query TEXT [--path PATH] [--mode content|files|count]
  safs edit --binding ID --path PATH --input EDITS.json
  safs write --binding ID --path PATH --file LOCAL_UTF8_FILE
  safs upload|download|move|chmod|delete|read-many --binding ID --input OPTIONS.json
  safs workspaces
  safs switch --workspace ID --confirmed true
  safs output --binding ID --id OUTPUT_ID --stream stdout|stderr [--offset N] [--length N]

Bind once and reuse the returned bindingId. Candidate lists require user selection
before switch --confirmed true; the CLI never picks a candidate. Stop the previous task after switching.
JSON input uses the corresponding remote tool fields (without bindingId). For example:
edit: {"edits":[{"oldText":"old","newText":"new"}],"expectedHash":"optional SHA-256"}
upload: {"localPaths":["/absolute/local/file"],"remoteDirectory":"."}
download: {"remotePath":"file","localPath":"/absolute/local/destination"}
read-many: {"requests":[{"path":"a","head":20}],"maxBytes":16384}
Use --input for search filters, batch paths and other advanced options.
Exec writes remote stdout/stderr directly and preserves the remote exit code.
Truncated output includes continuation metadata on stderr; output returns JSON.
No SSH credentials or remote service installation are needed by this wrapper.
`);
    return;
  }
  const request = await prepareCliRequest(args, process.cwd(), file => readFile(file, 'utf8'));
  let url = process.env.SAFS_MCP_URL;
  if (configFile) {
    let config;
    try { config = JSON.parse(await readFile(configFile, 'utf8')); }
    catch { throw new Error('Cannot read a valid SAFS connection file.'); }
    if (!config || config.version !== 1 || typeof config.url !== 'string') throw new Error('Invalid SAFS connection file.');
    url = config.url;
  }
  connectionUrl = url;
  if (!url) throw new Error('Use --config CONNECTION.json or set SAFS_MCP_URL.');
  const result = await callSafs(url, request);
  if (request.name !== 'run_remote_command') {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (typeof result.exitCode === 'number') {
      process.exitCode = Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255 ? result.exitCode : 1;
    } else if (result.status === 'error' || (Array.isArray(result.results)
        && result.results.some(item => item?.status === 'error'))) {
      process.exitCode = 1;
    }
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
  const url = connectionUrl ?? process.env.SAFS_MCP_URL;
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
