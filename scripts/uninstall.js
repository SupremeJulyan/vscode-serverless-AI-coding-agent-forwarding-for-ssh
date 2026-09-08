'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const pathBegin = '# SAFS CLI PATH BEGIN';
const pathEnd = '# SAFS CLI PATH END';

function withoutSafsPathBlock(content) {
  const pattern = new RegExp(
    `(?:^|\\n)${pathBegin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n` +
    `[\\s\\S]*?\\r?\\n${pathEnd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\r?\\n|$)`,
    'g'
  );
  return content.replace(pattern, (match) => match.startsWith('\n') ? '\n' : '');
}

async function removeUnixProfileBlock(profile) {
  let previous;
  try {
    previous = await fs.readFile(profile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const next = withoutSafsPathBlock(previous);
  if (next !== previous) await fs.writeFile(profile, next, { mode: 0o600 });
}

function removeWindowsUserPath(binDirectory, run = execFileSync) {
  const variable = 'SAFS_CLI_BIN_DIRECTORY';
  const script = [
    `$dir=$env:${variable}`,
    "$value=[Environment]::GetEnvironmentVariable('Path','User')",
    "if($value){$target=$dir.TrimEnd('\\');$parts=@($value -split ';' | Where-Object { $_ -and $_.Trim().TrimEnd('\\') -ine $target });$next=$parts -join ';';if($next -ne $value){[Environment]::SetEnvironmentVariable('Path',$next,'User')}}"
  ].join(';');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, [variable]: binDirectory },
    stdio: 'ignore',
    windowsHide: true
  });
}

async function cleanup(options = {}) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  if (platform === 'win32') {
    const installRoot = path.join(home, 'AppData', 'Local', 'SAFS');
    const binDirectory = path.join(installRoot, 'bin');
    // Update PATH even if the files were already removed manually.
    let pathError;
    try { removeWindowsUserPath(binDirectory, options.run); } catch (error) { pathError = error; }
    await fs.rm(installRoot, { recursive: true, force: true });
    if (pathError) throw pathError;
    return;
  }

  const binDirectory = path.join(home, '.local', 'bin');
  await Promise.all([
    fs.rm(path.join(binDirectory, 'safs'), { force: true }),
    fs.rm(path.join(binDirectory, '.safs-connection.json'), { force: true }),
    removeUnixProfileBlock(path.join(home, '.profile')),
    removeUnixProfileBlock(path.join(home, '.zprofile'))
  ]);
}

module.exports = { cleanup, removeWindowsUserPath, withoutSafsPathBlock };

if (require.main === module) {
  cleanup().catch((error) => {
    console.error(`SAFS uninstall cleanup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
