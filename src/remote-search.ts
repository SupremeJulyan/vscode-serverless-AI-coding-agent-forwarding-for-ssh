import { shellQuote } from './shell-quote';

export interface RemoteSearchOptions {
  query: string; path?: string; mode?: 'content' | 'files' | 'count' | 'names';
  fixedStrings?: boolean; ignoreCase?: boolean; contextLines?: number;
  include?: string[]; excludeDirs?: string[]; maxResults?: number;
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
    const command = `find ${shellQuote(searchPath)} ${excludedDirectories}-type f ${nameOperator} ${shellQuote(input.query)}${includeFilter} -print`;
    return {
      command: limitSearchOutput(command, input.maxResults),
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
  const command = `grep ${[...flags, ...filters].join(' ')} -- ${shellQuote(input.query)} ${shellQuote(searchPath)}`;
  return { command: limitSearchOutput(command, input.maxResults),
    mode, excludeDirs: excludes };
}

/**
 * The UI only renders a bounded result list. Asking for one extra line lets it
 * report truncation, while `head` closes the pipe as soon as that limit is met
 * so recursive grep/find do not keep walking a high-match tree unnecessarily.
 */
function limitSearchOutput(command: string, maxResults?: number): string {
  if (maxResults === undefined) return command;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 10_000) {
    throw new Error('maxResults must be an integer between 1 and 10000.');
  }
  return `${command} | head -n ${maxResults + 1}`;
}
