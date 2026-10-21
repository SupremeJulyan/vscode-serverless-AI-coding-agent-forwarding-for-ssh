import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  addRecordedMcpAgentName, normalizeAgentInterface, recordedMcpAgentNames,
  shouldCopyMcpUninstallPrompt
} from '../src/agent-interface';
import { agentTaggedMcpUrl } from '../src/agent-http-router';
import { streamableHttpMcpInstallPrompt } from '../src/node-cli-install';
import { UiOperationGate } from '../src/ui-operation';

async function uninstallPromptHarness() {
  const source = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  const syntax = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = syntax.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'copyMcpUninstallPromptAndNotify'
  );
  assert.ok(declaration);
  const script = ts.transpileModule(declaration.getText(syntax), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const state = {
    clipboardError: undefined as Error | undefined,
    dialogError: undefined as Error | undefined,
    copies: [] as string[],
    dialogs: [] as Array<{ confirmAction: string; finish(action?: string): void }>,
    agents: ['Codex'],
    updates: [] as string[][]
  };
  const context = { globalState: { update: async (key: string, names: string[]) => {
    assert.equal(key, 'installedAgents');
    state.agents = Array.from(names);
    state.updates.push(state.agents);
  } } };
  const notify = runInNewContext(`${script}\ncopyMcpUninstallPromptAndNotify;`, {
    mcpUninstallPrompts: new UiOperationGate(),
    mcpInstalledAgentsKey: 'installedAgents',
    installedMcpAgentNames: () => state.agents,
    streamableHttpMcpUninstallPrompt: () => 'uninstall safs',
    vscode: {
      env: { clipboard: { writeText: async (text: string) => {
        state.copies.push(text);
        if (state.clipboardError) throw state.clipboardError;
      } } },
      window: { showInformationMessage: (_message: string, _options: unknown, confirmAction: string) => {
        if (state.dialogError) throw state.dialogError;
        return new Promise<string | undefined>((finish) => {
          state.dialogs.push({ confirmAction, finish });
        });
      } }
    }
  }) as (context: unknown) => Promise<void>;
  return { state, notify: () => notify(context) };
}

async function interfaceChangeHarness(focused = true) {
  const source = await readFile(new URL('../src/extension.ts', import.meta.url), 'utf8');
  const syntax = ts.createSourceFile('extension.ts', source, ts.ScriptTarget.Latest, true);
  let listener: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'onDidChangeConfiguration') {
      const callback = node.arguments[0];
      if (callback && ts.isArrowFunction(callback)
        && callback.getText(syntax).includes('safs.agentInterface')) listener = callback;
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);
  assert.ok(listener);
  const integration = syntax.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'installAgentForwardingIntegration'
  );
  assert.ok(integration);
  const script = ts.transpileModule(`${integration.getText(syntax)}\nconst onChange = ${listener.getText(syntax)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText;
  const state = {
    current: 'cli' as 'cli' | 'mcp',
    window: { focused },
    agentName: 'Codex' as string | undefined,
    prompts: [] as string[],
    copies: [] as string[],
    agents: [] as string[],
    pending: [] as Promise<unknown>[]
  };
  const onChange = runInNewContext(`${script}\nonChange;`, {
    previousAgentInterface: 'cli',
    agentInterface: () => state.current,
    shouldCopyMcpUninstallPrompt,
    context: {},
    uiOperations: new UiOperationGate(),
    vscode: {
      window: { state: state.window, showInformationMessage: async () => undefined },
      env: { clipboard: { writeText: async (text: string) => { state.copies.push(text); } } }
    },
    bridgeOutput: { info() {} },
    refreshAgentCommandTerminalState: async () => {},
    startAgentHttpRouterLeadership() {},
    configureAgentInterface: async () => state.current === 'cli' ? { cliExecutable: '/safs' } : {},
    askAgentName: async () => { state.prompts.push('install'); return state.agentName; },
    ensureAgentHttpRouter: async () => ({ url: 'http://127.0.0.1:9848/mcp?token=test' }),
    agentTaggedMcpUrl,
    streamableHttpMcpInstallPrompt,
    recordInstalledMcpAgent: async (_context: unknown, agentName: string) => {
      state.agents.push(agentName);
    },
    copyMcpUninstallPromptAndNotify: async () => { state.prompts.push('uninstall'); },
    guard: (action: () => Promise<unknown>) => {
      const operation = action();
      state.pending.push(operation);
      return operation;
    }
  }) as (event: unknown) => void;
  return {
    state,
    change(current: 'cli' | 'mcp') {
      state.current = current;
      onChange({ affectsConfiguration: (key: string) => key === 'safs.agentInterface' });
    },
    settle: () => Promise.all(state.pending)
  };
}

test('supports only mutually exclusive MCP and CLI interfaces', () => {
  assert.equal(normalizeAgentInterface('mcp'), 'mcp');
  assert.equal(normalizeAgentInterface('cli'), 'cli');
  assert.equal(normalizeAgentInterface('removed-mode'), 'cli');
  assert.equal(normalizeAgentInterface(undefined), 'cli');
});

test('only an MCP to CLI transition copies the MCP uninstall prompt', () => {
  assert.equal(shouldCopyMcpUninstallPrompt('mcp', 'cli', true), true);
  assert.equal(shouldCopyMcpUninstallPrompt('cli', 'cli', true), false);
  assert.equal(shouldCopyMcpUninstallPrompt('mcp', 'mcp', true), false);
  assert.equal(shouldCopyMcpUninstallPrompt('cli', 'mcp', true), false);
});

test('a global interface change prompts only in the window that was focused', () => {
  const notifications = [false, true, false].map((focused) =>
    shouldCopyMcpUninstallPrompt('mcp', 'cli', focused)
  );
  assert.deepEqual(notifications, [false, true, false]);
});

test('switching CLI to MCP runs the installation prompt once in the originating window', async () => {
  const { state, change, settle } = await interfaceChangeHarness();
  change('mcp');
  state.window.focused = false;
  change('mcp');
  await settle();
  assert.deepEqual(state.prompts, ['install']);
  assert.deepEqual(state.copies, [streamableHttpMcpInstallPrompt(
    'http://127.0.0.1:9848/mcp?token=test&agent=Codex'
  )]);
  assert.deepEqual(state.agents, ['Codex']);
});

test('a background window never installs an MCP prompt after gaining focus', async () => {
  const { state, change, settle } = await interfaceChangeHarness(false);
  change('mcp');
  state.window.focused = true;
  await settle();
  assert.deepEqual(state.prompts, []);
  assert.deepEqual(state.copies, []);
});

test('cancelling the MCP Agent name leaves the clipboard and recorded Agents unchanged', async () => {
  const { state, change, settle } = await interfaceChangeHarness();
  state.agentName = undefined;
  change('mcp');
  await settle();
  assert.deepEqual(state.copies, []);
  assert.deepEqual(state.agents, []);
});

test('an outdated CLI to MCP setup never copies an installation prompt', async () => {
  const { state, change, settle } = await interfaceChangeHarness();
  change('mcp');
  change('cli');
  await settle();
  assert.deepEqual(state.prompts, ['uninstall']);
  assert.deepEqual(state.copies, []);
});

test('interface changes retain the MCP removal prompt when switching back to CLI', async () => {
  const { state, change, settle } = await interfaceChangeHarness();
  change('mcp');
  await settle();
  change('cli');
  await settle();
  assert.deepEqual(state.prompts, ['install', 'uninstall']);
});

test('duplicate MCP uninstall requests share one dialog and dismissal releases every caller', async () => {
  const { state, notify } = await uninstallPromptHarness();
  const first = notify();
  const second = notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.dialogs.length, 1);
  assert.equal(state.copies.length, 1);
  const third = notify();
  state.dialogs[0].finish();
  await Promise.all([first, second, third]);
  assert.deepEqual(state.updates, []);
  assert.deepEqual(state.agents, ['Codex']);

  const retry = notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.dialogs.length, 2);
  state.dialogs[1].finish(state.dialogs[1].confirmAction);
  await retry;
  assert.deepEqual(state.updates, [[]]);
});

test('clipboard and dialog errors release the MCP uninstall prompt for retry', async () => {
  const { state, notify } = await uninstallPromptHarness();
  state.clipboardError = new Error('clipboard unavailable');
  await assert.rejects(notify(), /clipboard unavailable/);
  state.clipboardError = undefined;
  state.dialogError = new Error('dialog unavailable');
  await assert.rejects(notify(), /dialog unavailable/);
  state.dialogError = undefined;
  const retry = notify();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.dialogs.length, 1);
  state.dialogs[0].finish();
  await retry;
  assert.deepEqual(state.updates, []);
});

test('records unique valid MCP Agent names for later uninstall guidance', () => {
  assert.deepEqual(recordedMcpAgentNames(['Codex', ' codex ', '', 3, 'Claude']), [
    'Codex', 'Claude'
  ]);
  assert.deepEqual(addRecordedMcpAgentName(['Codex'], 'Claude'), ['Codex', 'Claude']);
  assert.deepEqual(addRecordedMcpAgentName(['Codex'], 'codex'), ['Codex']);
});
