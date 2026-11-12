import { posix, join, relative, isAbsolute, sep, resolve } from 'node:path';
import type { GitResult } from './remote-git';
export interface GitDiscoveryWorkspace {
  kind: 'remote' | 'local'; root: string;
  runGit(args: string[], signal?: AbortSignal): Promise<GitResult>;
  list(path: string, signal?: AbortSignal): Promise<Array<{ name: string; path: string; directory: boolean; symlink?: boolean }>>;
  listForGit?(path: string, limit: number, signal?: AbortSignal): Promise<{ entries: Array<{ name: string; path: string; directory: boolean; symlink?: boolean }>; truncated: boolean }>;
}


const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', 'vendor', 'dist', 'build', 'target', '.next', '.cache']);
const notRepository = /not a git repository|不是\s*git\s*仓库/i;
export interface GitDiscovery { roots: string[]; truncated: boolean; skipped: string[] }
/** Stop awaiting an uncancellable native directory read when the scan is cancelled. */
async function cancellable<T>(operation:()=>Promise<T>,signal?:AbortSignal):Promise<T> {
  signal?.throwIfAborted();
  if(!signal)return operation();
  let abort:()=>void=()=>{};
  const cancelled=new Promise<never>((_resolve,reject)=>{
    abort=()=>reject(signal.reason??new Error('Git scan cancelled'));
    signal.addEventListener('abort',abort,{once:true});
  });
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return operation();}),cancelled]);}
  finally{signal.removeEventListener('abort',abort);}
}
/** Discover repositories rooted in the browsing directory or below, including worktrees. */
export async function discoverGitRepositories(workspace: GitDiscoveryWorkspace,
  options: { maxDepth?: number; maxDirectories?: number; maxRepositories?: number; concurrency?: number; maxEntries?:number; maxDurationMs?:number; scanNestedRepositories?: boolean; signal?: AbortSignal; onRepository?: (root:string)=>void } = {}): Promise<GitDiscovery> {
  const roots = new Set<string>(), skipped: string[] = [];
  let truncated = false, visited = 0, examined=0;
  options.signal?.throwIfAborted();
  const parentSignal=options.signal,controller=new AbortController();
  let timedOut=false;
  const abort=()=>controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort(new Error('Git discovery time limit'));},options.maxDurationMs??5000);
  options={...options,signal:controller.signal};
  try {
    const maxEntries=options.maxEntries??5000;
    const maxDepth = options.maxDepth ?? 3, maxDirectories = options.maxDirectories ?? 150;
    const maxRepositories = options.maxRepositories ?? 30;
    const absolute = (path: string) => workspace.kind === 'remote' ? posix.resolve(workspace.root, path) : join(workspace.root, path);
    const withinScope = (root:string) => {
      const child=workspace.kind==='remote'?posix.relative(workspace.root,root):relative(workspace.root,root);
      const separator=workspace.kind==='remote'?'/':sep;
      return child!=='..'&&!child.startsWith(`..${separator}`)&&!(workspace.kind==='remote'?posix.isAbsolute(child):isAbsolute(child));
    };
    const publish = (root:string) => {
      if(!root||roots.has(root))return;
      if(roots.size>=maxRepositories){truncated=true;return;}
      roots.add(root);options.onRepository?.(root);
    };
    const probe = async (path: string, ownRepository=false) => {
      options.signal?.throwIfAborted();
      const result = await cancellable(()=>workspace.runGit(['-C', absolute(path), 'rev-parse', '--show-toplevel'],options.signal),options.signal);
      options.signal?.throwIfAborted();
      if (result.truncated) throw new Error('Git repository path exceeded capture limit');
      if (result.exitCode === 0) { const output=result.stdout.trim(),root=output&&workspace.kind==='local'?resolve(output):output; if(root&&(ownRepository||withinScope(root)))publish(root); return root; }
      if (result.exitCode === 128 && notRepository.test(result.stderr + result.stdout)) return;
      throw new Error(result.stderr.trim() || result.stdout.trim() || `Git failed (${result.exitCode})`);
    };
    const initialRoot=await probe('.');
    // Git has already confirmed that the browsing path itself is the repository.
    // Symlink aliases still need the .git marker check below to establish scope.
    if(options.scanNestedRepositories===false&&initialRoot===absolute('.'))
      return {roots:[...roots].sort(),truncated,skipped};
    const queue = [{ path: '.', depth: 0 }];
    const concurrency=Math.max(1,Math.min(8,options.concurrency??6));
    while (queue.length) {
      options.signal?.throwIfAborted();
      if (visited >= maxDirectories || roots.size >= maxRepositories || examined>=maxEntries) { truncated = true; break; }
      const batch=queue.splice(0,Math.min(concurrency,maxDirectories-visited));
      visited+=batch.length;
      const readLimit=Math.min(2000,Math.floor((maxEntries-examined)/batch.length));
      if(readLimit<1){truncated=true;break;}
      await Promise.all(batch.map(async next=>{
        let entries;
        try {
          const limit=readLimit;
          const listing=await cancellable(()=>workspace.listForGit?workspace.listForGit(next.path,limit,options.signal):workspace.list(next.path,options.signal).then(entries=>({entries:entries.slice(0,limit),truncated:entries.length>limit})),options.signal);
          examined+=listing.entries.length;
          entries=listing.entries;
          if(listing.truncated)truncated=true;
        }
        catch (error) { options.signal?.throwIfAborted(); if (next.depth === 0) throw error; skipped.push(next.path); return; }
        options.signal?.throwIfAborted();
        const repository=entries.some(entry => entry.name === '.git');
        // A browsing path may be a symlink to the repository root. Its own .git
        // marker proves membership even when Git returns a different canonical path.
        if(next.depth===0&&repository&&initialRoot)publish(initialRoot);
        if (next.depth > 0 && repository) {
          if(roots.size>=maxRepositories){truncated=true;return;}
          try { await probe(next.path,true); } catch (error) { options.signal?.throwIfAborted(); skipped.push(`${next.path}: ${String(error)}`); }
        }
        // Scanning inside known repositories is optional: project discovery need not walk source/assets trees.
        if(repository&&options.scanNestedRepositories===false)return;
        const directories = entries.filter(entry => entry.directory && !entry.symlink && !ignored.has(entry.name));
        if (next.depth >= maxDepth) { if (directories.length) truncated = true; return; }
        for (const directory of directories) {
          if(queue.length>=maxDirectories-visited){truncated=true;break;}
          queue.push({ path: directory.path, depth: next.depth + 1 });
        }
      }));
    }
    return { roots: [...roots].sort(), truncated, skipped };
  }catch(error){
    if(timedOut&&!parentSignal?.aborted)return {roots:[...roots].sort(),truncated:true,skipped};
    throw error;
  }finally{clearTimeout(timer);parentSignal?.removeEventListener('abort',abort);}
}
