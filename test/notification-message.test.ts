import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));

function isMessageCall(node: ts.CallExpression): boolean {
  return ts.isPropertyAccessExpression(node.expression)
    && /^show(?:Information|Warning|Error)Message$/.test(node.expression.name.text);
}

function isModal(node: ts.CallExpression): boolean {
  const options = node.arguments[1];
  return !!options && ts.isObjectLiteralExpression(options)
    && options.properties.some((property) =>
      ts.isPropertyAssignment(property)
      && property.name.getText() === 'modal'
      && property.initializer.kind === ts.SyntaxKind.TrueKeyword
    );
}

function progressTitles(node: ts.Expression): string[] | undefined {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    const whenTrue = progressTitles(node.whenTrue);
    const whenFalse = progressTitles(node.whenFalse);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : undefined;
  }
  return undefined;
}

test('non-modal literal notifications remain short enough for narrow windows', async () => {
  const entries = await readdir(sourceRoot, { recursive: true });
  const violations: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    const file = path.join(sourceRoot, entry);
    const source = await readFile(file, 'utf8');
    const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isMessageCall(node) && !isModal(node)) {
        const message = node.arguments[0];
        if (message && ts.isStringLiteralLike(message) && [...message.text].length > 32) {
          const line = syntax.getLineAndCharacterOfPosition(message.getStart()).line + 1;
          violations.push(`${entry}:${line} (${[...message.text].length} chars): ${message.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);
  }
  assert.deepEqual(violations, []);
});

test('notification progress titles never contain unbounded paths or names', async () => {
  const entries = await readdir(sourceRoot, { recursive: true });
  const violations: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.ts')) continue;
    const file = path.join(sourceRoot, entry);
    const source = await readFile(file, 'utf8');
    const syntax = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)
          && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === 'withProgress') {
        const options = node.arguments[0];
        if (options && ts.isObjectLiteralExpression(options)) {
          const location = options.properties.find((property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) && property.name.getText() === 'location'
          );
          if (location?.initializer.getText().includes('ProgressLocation.Notification')) {
            const title = options.properties.find((property): property is ts.PropertyAssignment =>
              ts.isPropertyAssignment(property) && property.name.getText() === 'title'
            );
            const choices = title && progressTitles(title.initializer);
            if (!choices || choices.some((choice) => [...choice].length > 32)) {
              const line = syntax.getLineAndCharacterOfPosition(options.getStart()).line + 1;
              violations.push(`${entry}:${line}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(syntax);
  }
  assert.deepEqual(violations, []);
});
