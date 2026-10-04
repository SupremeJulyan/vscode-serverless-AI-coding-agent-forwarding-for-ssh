const fs = require('node:fs');
const path = require('node:path');
const extensionVersion = require('../package.json').version;

const files = [
  ['linux-x64/safs', '7f454c46'], ['linux-arm64/safs', '7f454c46'],
  ['darwin-x64/safs', 'cffaedfe'], ['darwin-arm64/safs', 'cffaedfe'],
  ['win32-x64/safs.exe', '4d5a'], ['win32-arm64/safs.exe', '4d5a']
];
const selected = process.env.SAFS_CLI_PLATFORM;
const checks = selected
  ? files.filter(([relative]) => relative.startsWith(`${selected}/`))
  : files;
if (selected && checks.length !== 1) throw new Error(`Unsupported SAFS CLI platform: ${selected}`);
for (const [relative, magic] of checks) {
  const file = path.join('bin', relative);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 100 * 1024) throw new Error(`Invalid native CLI: ${file}`);
  const descriptor = fs.openSync(file, 'r');
  const prefix = Buffer.alloc(magic.length / 2);
  fs.readSync(descriptor, prefix); fs.closeSync(descriptor);
  if (prefix.toString('hex') !== magic) throw new Error(`Unexpected executable format: ${file}`);
  const content = fs.readFileSync(file);
  if (!content.includes(Buffer.from(`safs ${extensionVersion}`))) {
    throw new Error(`Native CLI version does not match ${extensionVersion}: ${file}`);
  }
  const platform = relative.split('/')[0];
  const release = path.join(
    'release-assets', `safs-${platform}${platform.startsWith('win32-') ? '.exe' : ''}`
  );
  if (fs.existsSync(release) && !content.equals(fs.readFileSync(release))) {
    throw new Error(`Release asset does not match built CLI: ${release}`);
  }
}
console.log(`Verified ${checks.length} SAFS native executable${checks.length === 1 ? '' : 's'}.`);
