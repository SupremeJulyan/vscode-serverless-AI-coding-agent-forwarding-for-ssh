const { execFileSync } = require('node:child_process');
const { copyFileSync, chmodSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const rustTargets = {
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc'
};

const platform = process.env.SAFS_CLI_PLATFORM ?? `${process.platform}-${process.arch}`;
const target = process.env.SAFS_CLI_RUST_TARGET ?? rustTargets[platform];
if (!target) throw new Error(`Unsupported SAFS CLI platform: ${platform}`);
execFileSync('cargo', [
  'build', '--release', '--locked', '--manifest-path', 'native-cli/Cargo.toml', '--target', target
], { stdio: 'inherit' });
const executable = process.platform === 'win32' || platform.startsWith('win32-') ? 'safs.exe' : 'safs';
const source = path.join('native-cli', 'target', target, 'release', executable);
const destinationDirectory = path.join('bin', platform);
mkdirSync(destinationDirectory, { recursive: true });
const destination = path.join(destinationDirectory, executable);
copyFileSync(source, destination);
if (!executable.endsWith('.exe')) chmodSync(destination, 0o755);
console.log(`SAFS native CLI: ${destination}`);
