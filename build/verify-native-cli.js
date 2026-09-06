const fs = require('node:fs');
const path = require('node:path');

const files = [
  ['linux-x64/safs', '7f454c46'], ['linux-arm64/safs', '7f454c46'],
  ['darwin-x64/safs', 'cffaedfe'], ['darwin-arm64/safs', 'cffaedfe'],
  ['win32-x64/safs.exe', '4d5a'], ['win32-arm64/safs.exe', '4d5a']
];
for (const [relative, magic] of files) {
  const file = path.join('bin', relative);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size < 100 * 1024) throw new Error(`Invalid native CLI: ${file}`);
  const descriptor = fs.openSync(file, 'r');
  const prefix = Buffer.alloc(magic.length / 2);
  fs.readSync(descriptor, prefix); fs.closeSync(descriptor);
  if (prefix.toString('hex') !== magic) throw new Error(`Unexpected executable format: ${file}`);
}
console.log(`Verified ${files.length} SAFS native executables.`);
