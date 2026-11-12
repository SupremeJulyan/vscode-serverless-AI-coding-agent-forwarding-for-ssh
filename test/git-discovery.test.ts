import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, opendir, realpath } from 'node:fs/promises';
import type { GitDiscoveryWorkspace } from '../src/git/git-discovery';
import { discoverGitRepositories } from '../src/git/git-discovery';
const execute=promisify(execFile);
function localWorkspace(root: string): GitDiscoveryWorkspace {
  const entry = (directory: string, value: import('node:fs').Dirent) => ({
    name: value.name, path: join(directory, value.name), directory: value.isDirectory(), symlink: value.isSymbolicLink()
  });
  return {
    kind: 'local', root,
    runGit: async (args, signal) => {
      try { const result = await execute('git', ['-C', root, ...args], { signal }); return { ...result, exitCode: 0 }; }
      catch (error) { const result = error as { code: number; stdout: string; stderr: string }; return { ...result, exitCode: result.code }; }
    },
    list: async directory => (await readdir(join(root, directory), { withFileTypes: true })).map(value => entry(directory, value)),
    listForGit: async (directory, limit) => {
      const entries = []; let truncated = false;
      for await (const value of await opendir(join(root, directory))) {
        if (entries.length >= limit) { truncated = true; break; }
        entries.push(entry(directory, value));
      }
      return { entries, truncated };
    }
  };
}

test('an ordinary folder is a normal empty Git discovery result',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'arw-git-discovery-')));t.after(()=>rm(root,{recursive:true,force:true}));
  assert.deepEqual((await discoverGitRepositories(localWorkspace(root))).roots,[]);
});
test('discovers multiple projects, nested repositories, and worktree .git files',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'arw-git-discovery-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const first=join(root,'one'),second=join(root,'two'),linked=join(root,'linked');
  await execute('git',['init','-b','main',first]);await execute('git',['init','-b','main',second]);
  await execute('git',['-C',first,'-c','user.name=Test','-c','user.email=test@example.test','commit','--allow-empty','-m','first']);
  await execute('git',['-C',first,'worktree','add','-b','linked',linked]);
  const nested=join(second,'nested');await execute('git',['init','-b','main',nested]);
  assert.deepEqual((await discoverGitRepositories(localWorkspace(root))).roots,[first,second,linked,nested].sort());
  assert.ok((await discoverGitRepositories(localWorkspace(nested))).roots.includes(nested));
});
test('discovery skips dependency folders and reports bounded scans',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'arw-git-discovery-')));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'node_modules'));await execute('git',['init',join(root,'node_modules','ignored')]);
  await mkdir(join(root,'projects'));await execute('git',['init',join(root,'projects','real')]);
  const workspace=localWorkspace(root);
  assert.deepEqual((await discoverGitRepositories(workspace)).roots,[join(root,'projects','real')]);
  assert.equal((await discoverGitRepositories(workspace,{maxDirectories:1})).truncated,true);
});
test('authentication, unsafe ownership and missing Git errors are not hidden as non-repositories',async()=>{
  for(const [exitCode,stderr] of [[128,'fatal: detected dubious ownership in repository'],[127,'git: command not found']] as const){
    const workspace={...localWorkspace('/tmp'),runGit:async()=>({exitCode,stdout:'',stderr})};
    await assert.rejects(discoverGitRepositories(workspace),new RegExp(stderr));
  }
});


test('project discovery bounds concurrency, publishes roots early, and avoids traversing repository assets',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'arw-git-perf-')));t.after(()=>rm(root,{recursive:true,force:true}));
  for(const name of ['one','two','three','four']){
    await execute('git',['init',join(root,name)]);
    await Promise.all(Array.from({length:50},(_,index)=>mkdir(join(root,name,`assets-${index}`))));
  }
  const base=localWorkspace(root);let calls=0,running=0,peak=0,finished=false;
  const workspace={...base,listForGit:undefined,list:async(path:string)=>{
    calls++;running++;peak=Math.max(peak,running);
    try{await new Promise(resolve=>setTimeout(resolve,2));return await base.list(path)}finally{running--}
  }};
  await discoverGitRepositories(workspace);assert.equal(calls,150);
  calls=0;peak=0;const reported:string[]=[];
  const result=await discoverGitRepositories(workspace,{scanNestedRepositories:false,onRepository:root=>{
    assert.equal(finished,false);reported.push(root);
  }});finished=true;
  assert.equal(calls,5);assert.ok(peak>1&&peak<=6);
  assert.equal(result.truncated,false);assert.deepEqual([...reported].sort(),result.roots);assert.equal(result.roots.length,4);
  assert.equal((await discoverGitRepositories(workspace,{maxRepositories:1})).roots.length,1);
  const controller=new AbortController();controller.abort();await assert.rejects(discoverGitRepositories(workspace,{signal:controller.signal}));
});

test('cancelling a scan stops pending native directory reads and never starts later work',async()=>{
  const controller=new AbortController();
  let started!:()=>void,release!:(entries:[])=>void,received:AbortSignal|undefined,calls=0;
  const listing=new Promise<void>(resolve=>{started=resolve});
  const workspace={...localWorkspace('/tmp'),listForGit:undefined,
    runGit:async()=>({exitCode:128,stdout:'',stderr:'not a git repository'}),
    list:async(_path:string,signal?:AbortSignal):Promise<[]>=>{
      calls++;received=signal;started();return new Promise(resolve=>{release=resolve});
    },
  };
  const scanning=discoverGitRepositories(workspace,{signal:controller.signal});
  await listing;
  controller.abort(new Error('scan cancelled'));
  await assert.rejects(scanning,/scan cancelled/);
  assert.equal(received?.aborted,true);assert.equal(received?.reason,controller.signal.reason);assert.equal(calls,1);
  release([]);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,1);
});

test('a repository above the browsing directory is excluded, but repositories below it are discovered',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'arw-git-scope-')));t.after(()=>rm(root,{recursive:true,force:true}));
  await execute('git',['init','-b','main',root]);
  const bin=join(root,'bin');await mkdir(bin);
  const published:string[]=[];
  assert.deepEqual((await discoverGitRepositories(localWorkspace(bin),{onRepository:value=>published.push(value)})).roots,[]);
  assert.deepEqual(published,[],'ancestor is never published to the UI');
  const child=join(bin,'tool');await execute('git',['init','-b','main',child]);
  assert.deepEqual((await discoverGitRepositories(localWorkspace(bin),{scanNestedRepositories:false})).roots,[child]);
  assert.deepEqual((await discoverGitRepositories(localWorkspace(root),{scanNestedRepositories:false})).roots,[root]);
});

test('a symlink to a repository root keeps the repository in scope',async t=>{
  if(process.platform==='win32'){t.skip('POSIX directory symlink');return;}
  const {symlink}=await import('node:fs/promises');
  const root=await realpath(await mkdtemp(join(tmpdir(),'arw-git-symlink-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const repo=join(root,'repo'),link=join(root,'link');await execute('git',['init',repo]);await symlink(repo,link);
  assert.deepEqual((await discoverGitRepositories(localWorkspace(link))).roots,[repo]);
});

test('entry budgets bound concurrent enumeration and report incomplete scans',async()=>{
  let read=0,peakLimit=0
  const workspace={...localWorkspace('/tmp'),
    runGit:async()=>({exitCode:128,stdout:'',stderr:'not a git repository'}),
    list:async()=>{throw new Error('unbounded listing must not run')},
    listForGit:async(path:string,limit:number)=>{
      peakLimit=Math.max(peakLimit,limit)
      const count=path==='.'?8:limit
      read+=count
      return {entries:Array.from({length:count},(_,i)=>({name:`dir${i}`,path:`${path}/dir${i}`,directory:true,symlink:false})),truncated:path!=='.'}
    },
  }
  const result=await discoverGitRepositories(workspace,{maxEntries:20,concurrency:4})
  assert.equal(result.truncated,true)
  assert.ok(read<=20)
  assert.ok(peakLimit<=2000)
})

test('a discovery deadline stops a stalled listing while preserving discovered repositories',async()=>{
  let signal:AbortSignal|undefined
  const workspace={...localWorkspace('/tmp'),
    runGit:async()=>({exitCode:0,stdout:'/tmp\n',stderr:''}),
    listForGit:async(_path:string,_limit:number,received?:AbortSignal)=>{signal=received;return new Promise<never>(()=>{})},
  }
  const result=await discoverGitRepositories(workspace,{maxDurationMs:20})
  assert.deepEqual(result.roots,[resolve('/tmp')])
  assert.equal(result.truncated,true)
  assert.equal(signal?.aborted,true)
})

test('native Git discovery enumeration stops before materializing an entire directory',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'arw-bounded-list-')));t.after(()=>rm(root,{recursive:true,force:true}))
  await Promise.all(Array.from({length:12},(_,i)=>writeFile(join(root,`${i}.txt`),'')))
  const result=await localWorkspace(root).listForGit!('.',3)
  assert.equal(result.entries.length,3)
  assert.equal(result.truncated,true)
})

test('discovery at a confirmed repository root needs no directory enumeration when nested scanning is disabled',async context=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'arw-git-direct-')));context.after(()=>rm(root,{recursive:true,force:true}));
  await execute('git',['init',root]);
  const base=localWorkspace(root);let probes=0;
  const workspace={...base,runGit:async(...args:Parameters<NonNullable<typeof base.runGit>>)=>{probes++;return base.runGit!(...args)},
    listForGit:async()=>{throw new Error('Repository discovery must not enumerate source files')}};
  const result=await discoverGitRepositories(workspace,{scanNestedRepositories:false});
  assert.equal(result.roots.length,1);assert.equal(result.truncated,false);assert.equal(probes,1);
})
