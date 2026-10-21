import * as path from 'node:path';
import { isRemotePathInsideRoot } from './sftp/uri';

export interface RemoteCommandBoundaryViolation {
  kind: 'working-directory' | 'write-target';
  target: string;
}

const harmlessDeviceTargets = new Set([
  '/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'
]);

/** Split command lists without treating separators inside quotes as control operators. */
function shellSegments(command: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === ';' || character === '\n' || character === '|'
        || (character === '&' && command[index - 1] !== '>')) {
      const segment = command.slice(start, index).trim();
      if (segment) result.push(segment);
      if ((character === '|' || character === '&') && command[index + 1] === character) {
        index += 1;
      }
      start = index + 1;
    }
  }
  const tail = command.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function shellWords(segment: string): string[] {
  const result: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  for (const match of segment.matchAll(pattern)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) result.push(value);
  }
  return result;
}

function positionalArguments(words: string[]): string[] {
  return words.filter((word) => word !== '--' && !word.startsWith('-'));
}

function executableIndex(words: string[]): number {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  while (index < words.length) {
    const wrapper = path.posix.basename(words[index].replace(/^\\+/, ''));
    if (!['command', 'builtin', 'nohup', 'env'].includes(wrapper)) break;
    index += 1;
    while (index < words.length && (words[index].startsWith('-')
      || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]))) index += 1;
  }
  return index;
}

function writeTargets(segment: string): string[] {
  const targets: string[] = [];
  const redirect = /(?:^|[\s;&|()])(?:\d*)?(?:>>?|>\|)\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s;&|]+))/g;
  for (const match of segment.matchAll(redirect)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target && !target.startsWith('&')) targets.push(target);
  }

  const words = shellWords(segment);
  const index = executableIndex(words);
  const command = path.posix.basename((words[index] ?? '').replace(/^\\+/, ''));
  const remaining = positionalArguments(words.slice(index + 1));
  if (['touch', 'mkdir', 'rm', 'rmdir', 'unlink', 'tee', 'truncate'].includes(command)) {
    targets.push(...remaining);
  } else if (command === 'chmod' || command === 'chown') {
    targets.push(...remaining.slice(1));
  } else if (command === 'mv') {
    targets.push(...remaining);
  } else if (['cp', 'install', 'ln', 'rsync', 'scp'].includes(command)) {
    const target = remaining.at(-1);
    if (target) targets.push(target);
  } else if (command === 'dd') {
    for (const word of words.slice(index + 1)) {
      if (word.startsWith('of=') && word.length > 3) targets.push(word.slice(3));
    }
  }
  return targets;
}

function resolveTarget(remoteCwd: string, rawTarget: string): string | undefined {
  const target = rawTarget.trim();
  if (!target || target === '-' || target.startsWith('&')) return undefined;
  if (harmlessDeviceTargets.has(target) || /^\/dev\/fd\/\d+$/.test(target)) return undefined;
  // A dynamic shell destination cannot be proven to stay inside the selected workspace.
  if (target.startsWith('~') || /[$`*?\[]/.test(target)) return target;
  return target.startsWith('/')
    ? path.posix.normalize(target)
    : path.posix.resolve(remoteCwd, target);
}

/**
 * Reject explicit shell working directories and common file-write targets that escape the
 * selected SAFS workspace. This is a guardrail, not a general-purpose shell sandbox.
 */
export function remoteCommandBoundaryViolation(
  command: string, workspaceRoot: string, initialCwd: string
): RemoteCommandBoundaryViolation | undefined {
  let currentCwd = path.posix.normalize(initialCwd);
  if (!isRemotePathInsideRoot(workspaceRoot, currentCwd)) {
    return { kind: 'working-directory', target: initialCwd };
  }
  for (const segment of shellSegments(command)) {
    const words = shellWords(segment);
    const commandIndex = executableIndex(words);
    const commandName = path.posix.basename((words[commandIndex] ?? '').replace(/^\\+/, ''));
    if (commandName === 'cd' || commandName === 'pushd') {
      const requested = positionalArguments(words.slice(commandIndex + 1))[0];
      const resolved = requested && requested !== '-'
        ? resolveTarget(currentCwd, requested) : requested ?? '~';
      if (!resolved || !resolved.startsWith('/')
          || !isRemotePathInsideRoot(workspaceRoot, resolved)) {
        return { kind: 'working-directory', target: requested ?? '~' };
      }
      currentCwd = resolved;
    }
    if (commandName === 'popd') {
      return { kind: 'working-directory', target: 'popd' };
    }
    for (const rawTarget of writeTargets(segment)) {
      const resolved = resolveTarget(currentCwd, rawTarget);
      if (resolved && (!resolved.startsWith('/')
          || !isRemotePathInsideRoot(workspaceRoot, resolved))) {
        return { kind: 'write-target', target: rawTarget };
      }
    }
  }
  return undefined;
}
