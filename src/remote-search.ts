import { shellQuote } from './shell-quote';

export interface RemoteSearchOptions {
  query: string; path?: string; mode?: 'content' | 'files' | 'count' | 'names';
  fixedStrings?: boolean; ignoreCase?: boolean; contextLines?: number;
  include?: string[]; excludeDirs?: string[];
}
export const defaultSearchExcludes = ['.git', 'node_modules', 'dist', 'build', 'out', 'target',
  '.venv', 'venv', '__pycache__', '.next', '.cache', 'coverage', 'vendor', '.tox',
  'site-packages', 'bower_components', 'Pods', '.gradle'];

export function searchCommand(searchPath: string, input: RemoteSearchOptions) {
  const mode = input.mode ?? 'content';
  const excludes = input.excludeDirs ?? defaultSearchExcludes;
  if (mode === 'names') {
    if (input.contextLines) throw new Error('contextLines is not valid for filename search.');
    if (input.fixedStrings) throw new Error('fixedStrings is not valid for filename search; query is a basename glob.');
    const nameOperator = input.ignoreCase ? '-iname' : '-name';
    const excludedDirectories = excludes.length
      ? `\\( -type d \\( ${excludes.map(dir => `-name ${shellQuote(dir)}`).join(' -o ')} \\) -prune \\) -o `
      : '';
    const includeFilter = input.include?.length
      ? ` \\( ${input.include.map(glob => `${nameOperator} ${shellQuote(glob)}`).join(' -o ')} \\)`
      : '';
    return {
      command: `find ${shellQuote(searchPath)} ${excludedDirectories}-type f ${nameOperator} ${shellQuote(input.query)}${includeFilter} -print`,
      mode, excludeDirs: excludes
    };
  }
  if (mode !== 'content' && input.contextLines) throw new Error('contextLines requires content mode.');
  const flags = ['-rI', mode === 'files' ? '-l' : mode === 'count' ? '-cH' : '-nH'];
  if (input.fixedStrings) flags.push('-F');
  if (input.ignoreCase) flags.push('-i');
  if (input.contextLines) flags.push(`-C ${input.contextLines}`);
  const filters = [...excludes.map(dir => `--exclude-dir=${shellQuote(dir)}`),
    ...(input.include ?? []).map(glob => `--include=${shellQuote(glob)}`)];
  return { command: `grep ${[...flags, ...filters].join(' ')} -- ${shellQuote(input.query)} ${shellQuote(searchPath)}`,
    mode, excludeDirs: excludes };
}
