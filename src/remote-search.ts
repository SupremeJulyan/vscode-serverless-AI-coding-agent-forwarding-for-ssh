import { shellQuote } from './shell-quote';

export interface RemoteSearchOptions {
  query: string; path?: string; mode?: 'content' | 'files' | 'count';
  fixedStrings?: boolean; ignoreCase?: boolean; contextLines?: number;
  include?: string[]; excludeDirs?: string[];
}
export const defaultSearchExcludes = ['.git', 'node_modules', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage', 'vendor', '.tox',
  'site-packages', 'bower_components', 'Pods', '.gradle'];

export function searchCommand(searchPath: string, input: RemoteSearchOptions) {
  const mode = input.mode ?? 'content';
  if (mode !== 'content' && input.contextLines) throw new Error('contextLines requires content mode.');
  const flags = ['-rI', mode === 'files' ? '-l' : mode === 'count' ? '-cH' : '-nH'];
  if (input.fixedStrings) flags.push('-F');
  if (input.ignoreCase) flags.push('-i');
  if (input.contextLines) flags.push(`-C ${input.contextLines}`);
  const excludes = input.excludeDirs ?? defaultSearchExcludes;
  const filters = [...excludes.map(dir => `--exclude-dir=${shellQuote(dir)}`),
    ...(input.include ?? []).map(glob => `--include=${shellQuote(glob)}`)];
  return { command: `grep ${[...flags, ...filters].join(' ')} -- ${shellQuote(input.query)} ${shellQuote(searchPath)}`,
    mode, excludeDirs: excludes };
}
