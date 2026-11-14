// Load the actual packaged bundle with the VS Code types used during module
// initialization. Activation itself requires a running extension host.
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
if (!fs.readFileSync(path.join(__dirname, '../dist/extension.js'), 'utf8').includes('_motdHandled')) {
  throw new Error('Extension bundle is missing the SFTP gateway banner patch');
}
const originalLoad = Module._load;
class Stub { dispose() {} }
const vscode = {
  TreeItem: Stub, EventEmitter: Stub, Disposable: Stub, ThemeIcon: Stub,
  workspace: { getConfiguration: () => ({ get: (_name, fallback) => fallback }) },
  Uri: { file: value => ({ fsPath: value }), parse: value => ({ toString: () => value }) }
};
try {
  Module._load = function (name, ...args) {
    return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
  };
  const extension = require('../dist/extension.js');
  if (typeof extension.activate !== 'function' || typeof extension.deactivate !== 'function') {
    throw new Error('Extension bundle is missing activation exports');
  }
  console.log('Extension bundle load verified');
} finally {
  Module._load = originalLoad;
}
