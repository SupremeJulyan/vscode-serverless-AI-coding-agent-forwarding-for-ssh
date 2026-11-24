const Module = require('node:module');

const vscodeMock = {
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15, Window: 10 },
  EventEmitter: class {
    constructor() {
      this.listeners = new Set();
      this.event = (listener, thisArgs) => {
        const bound = thisArgs ? listener.bind(thisArgs) : listener;
        this.listeners.add(bound);
        return { dispose: () => this.listeners.delete(bound) };
      };
    }
    fire(value) { for (const listener of this.listeners) listener(value); }
    dispose() { this.listeners.clear(); }
  },
  window: {
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined
  },
  workspace: {
    getConfiguration: () => ({ get: (_name, fallback) => fallback })
  }
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};
