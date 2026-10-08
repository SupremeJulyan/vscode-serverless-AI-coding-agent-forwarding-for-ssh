// Load the actual packaged bundle with the VS Code types used during module
// initialization. Activation itself requires a running extension host.
const Module = require('node:module');
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
