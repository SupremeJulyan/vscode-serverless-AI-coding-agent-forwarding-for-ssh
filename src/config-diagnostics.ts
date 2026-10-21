import * as vscode from 'vscode';
import * as path from 'node:path';
import { configUniquenessTextIssues } from './config-uniqueness';

export function registerConfigDiagnostics(context: vscode.ExtensionContext, configPath: () => string): void {
  const diagnostics = vscode.languages.createDiagnosticCollection('safs-config');
  const update = (document: vscode.TextDocument) => {
    if (document.uri.scheme !== 'file' || path.resolve(document.uri.fsPath) !== path.resolve(configPath())) return;
    diagnostics.set(document.uri, configUniquenessTextIssues(document.getText()).map(issue => {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(document.positionAt(issue.offset), document.positionAt(issue.offset + issue.length)),
        issue.message, vscode.DiagnosticSeverity.Error
      );
      diagnostic.source = 'SAFS';
      return diagnostic;
    }));
  };
  context.subscriptions.push(diagnostics,
    vscode.workspace.onDidOpenTextDocument(update),
    vscode.workspace.onDidChangeTextDocument(event => update(event.document)),
    vscode.workspace.onDidCloseTextDocument(document => diagnostics.delete(document.uri)));
  vscode.workspace.textDocuments.forEach(update);
}
