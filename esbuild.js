const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');

// Remove native artifacts left by builds made with the previous SSH backend.
fs.rmSync(path.join(__dirname, 'dist', 'native'), { recursive: true, force: true });

// WSL scripts are packaged directly from resources/. Remove copies produced by
// older builds so VSIX packages contain a single authoritative set.
const wslOut = path.join(__dirname, 'dist', 'resources', 'wsl');
fs.rmSync(wslOut, { recursive: true, force: true });

if (production) {
  // Development builds create this map. Do not let a stale artifact leak into
  // production VSIX packages, where it adds several megabytes but is unused.
  fs.rmSync(path.join(__dirname, 'dist', 'extension.js.map'), { force: true });
  fs.rmSync(path.join(__dirname, 'dist', 'safs-cli.js.map'), { force: true });
}

esbuild.build({
  entryPoints: {
    extension: 'src/extension.ts'
  },
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  // The UMD entry passes require into a factory, hiding relative imports from
  // esbuild. Bundle the ESM entry so no ./impl/* imports escape into the VSIX.
  alias: { 'jsonc-parser': require.resolve('jsonc-parser/lib/esm/main.js') },
  outdir: 'dist',
  // cpu-features is an optional native optimization in ssh2; omitting it lets
  // ssh2 use its built-in crypto path on every supported VS Code platform.
  external: ['vscode', 'cpu-features'],
  logLevel: 'info',
}).catch(() => process.exit(1));

esbuild.build({
  entryPoints: ['src/safs-cli.ts'], bundle: true, platform: 'node', target: 'node18',
  format: 'cjs', outfile: 'dist/safs-cli.js', minify: production,
  define: {
    CLI_VERSION: JSON.stringify(require('./package.json').version),
    CLI_SKILL: JSON.stringify(fs.readFileSync('skills/safs-cli/SKILL.md', 'utf8')),
    CLI_REFERENCE: JSON.stringify(fs.readFileSync('skills/safs-cli/references/commands.md', 'utf8'))
  }
}).catch(() => process.exit(1));
