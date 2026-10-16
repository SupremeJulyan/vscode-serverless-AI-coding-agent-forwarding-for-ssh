import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  addRecordedMcpAgentName, normalizeAgentInterface, recordedMcpAgentNames,
  shouldCopyMcpUninstallPrompt
} from '../src/agent-interface';
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
