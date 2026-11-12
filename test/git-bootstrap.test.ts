import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, copyFile, readdir, access, chmod, symlink, readlink, stat, lstat, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cloneThroughLocalGit, initializeRemoteGit, validateGitIdentity, cloneDirectory } from '../src/git/git-bootstrap';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
import { localGitRunner } from '../src/git/local-git-push';
import type { CloneTransport } from '../src/git/git-bootstrap';
const identity={name:"Alice O'Neil",email:'alice+test@example.test',url:'https://example.test/owner/project.git'};

async function fixture(t:any,empty=false){
  const root=await realpath(await mkdtemp(join(tmpdir(),'arw-git-bootstrap-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const upstream=join(root,'upstream.git'),seed=join(root,'seed'),remote=join(root,'remote'),storagePath=join(root,'cache');
  const git=localGitRunner();
  await mkdir(remote);await git(['init','--bare','-b','main',upstream]);
  if(!empty){
    await git(['clone',upstream,seed]);
    await git(['-C',seed,'config','user.name','Fixture']);await git(['-C',seed,'config','user.email','fixture@example.test']);
    await writeFile(join(seed,'file.txt'),'contents');await writeFile(join(seed,'run.sh'),'#!/bin/sh\n');await chmod(join(seed,'run.sh'),0o755);if(process.platform!=='win32')await symlink('file.txt',join(seed,'linked.txt'));await git(['-C',seed,'add','.']);await git(['-C',seed,'commit','-m','initial']);
    await git(['-C',seed,'branch','feature']);await git(['-C',seed,'tag','v1']);await git(['-C',seed,'push','--all','origin']);await git(['-C',seed,'push','--tags','origin']);
  }
  const commands:string[]=[],localCommands:string[][]=[],workspace={ run: async (command: string, signal?: AbortSignal) => {
    try { const result=await execute('sh',['-c',command],{cwd:remote,signal});return {...result,exitCode:0}; }
    catch(error){const result=error as {code:number;stdout:string;stderr:string};return {...result,exitCode:result.code};}
  }};
  const transport:CloneTransport={root:remote, realpath: async value => realpath(value),
    run:async(command,signal)=>{commands.push(command);return workspace.run(command,signal)},
    upload:async(source,target)=>{await copyFile(source,target)},
    remove:async path=>{await rm(path,{force:true})},
    publish:async(source,target,signal)=>{
      signal?.throwIfAborted();
      const exists=await lstat(target).catch(error=>{if(error.code==='ENOENT')return undefined;throw error});
      if(exists)throw new Error('Destination already exists');
      await rename(source,target);
    },
  };
  const local:ReturnType<typeof localGitRunner>=async(args,signal,report)=>{
    localCommands.push(args);return git(args.map(value=>value===identity.url?upstream:value),signal,report);
  };
  return {root,upstream,remote,storagePath,workspace,transport,local,git,commands,localCommands};
}

test('local clone transfers branches, tags and checkout by bundle and keeps the original origin URL',{ skip: process.platform === 'win32' ? 'POSIX SSH-host fixture' : false }, async t=>{
  const f=await fixture(t);
  await writeFile(join(f.remote,'existing.txt'),'keep');
  const target=await cloneThroughLocalGit(f.transport,{...identity,directory:'project'},{storagePath:f.storagePath,local:f.local});
  assert.equal(target,join(f.remote,'project'));
  assert.equal(await readFile(join(target,'file.txt'),'utf8'),'contents');
  if(process.platform!=='win32'){assert.equal(await readlink(join(target,'linked.txt')),'file.txt');assert.ok((await stat(join(target,'run.sh'))).mode & 0o111);}
  assert.equal(await readFile(join(f.remote,'existing.txt'),'utf8'),'keep');
  assert.equal((await f.git(['-C',target,'remote','get-url','origin'])).trim(),identity.url);
  assert.equal((await f.git(['-C',target,'config','--local','user.email'])).trim(),identity.email);
  assert.equal((await f.git(['-C',target,'rev-parse','--abbrev-ref','@{upstream}'])).trim(),'origin/main');
  assert.equal((await f.git(['-C',target,'rev-parse','refs/remotes/origin/feature'])).trim(),(await f.git(['-C',target,'rev-parse','HEAD'])).trim());
  assert.equal((await f.git(['-C',target,'tag'])).trim(),'v1');
  assert.ok(f.localCommands.some(args=>args[0]==='clone'&&args.includes(identity.url)));
  assert.ok(f.commands.every(command=>!command.includes("'clone'")));
  assert.ok(f.commands.filter(command=>command.includes("'fetch'")).every(command=>!command.includes(identity.url)));
  assert.deepEqual(await readdir(f.storagePath),[]);
  assert.deepEqual((await readdir(f.remote)).filter(name=>name.startsWith('.safs-clone-')),[]);
  await assert.rejects(cloneThroughLocalGit(f.transport,{...identity,directory:'project'},{storagePath:f.storagePath,local:f.local}));
  assert.equal(await readFile(join(target,'file.txt'),'utf8'),'contents');
});

test('cloning an empty upstream initializes a usable remote repository without an empty bundle',{ skip: process.platform === 'win32' ? 'POSIX SSH-host fixture' : false }, async t=>{
  const f=await fixture(t,true);
  const target=await cloneThroughLocalGit(f.transport,{...identity,directory:'empty'},{storagePath:f.storagePath,local:f.local});
  assert.equal((await f.git(['-C',target,'symbolic-ref','--short','HEAD'])).trim(),'main');
  assert.equal((await f.git(['-C',target,'config','--local','user.name'])).trim(),identity.name);
  assert.equal((await f.git(['-C',target,'remote','get-url','origin'])).trim(),identity.url);
  assert.deepEqual((await readdir(target)).filter(name=>name!=='.git'),[]);
});

test('failed and cancelled clones clean their staging directories and never publish a partial project',{ skip: process.platform === 'win32' ? 'POSIX SSH-host fixture' : false }, async t=>{
  const f=await fixture(t);
  await assert.rejects(cloneThroughLocalGit({...f.transport,upload:async()=>{throw Error('SFTP failed')}},{...identity,directory:'failed'},{storagePath:f.storagePath,local:f.local}),/SFTP failed/);
  await assert.rejects(access(join(f.remote,'failed')));
  assert.deepEqual(await readdir(f.remote),[]);
  assert.deepEqual(await readdir(f.storagePath),[]);
  const controller=new AbortController();
  const beforeCancelledClone=f.commands.length;
  await assert.rejects(cloneThroughLocalGit({...f.transport,upload:async(source,target)=>{await copyFile(source,target);controller.abort()}},{...identity,directory:'cancelled'},{storagePath:f.storagePath,local:f.local,signal:controller.signal}));
  assert.equal(f.commands.slice(beforeCancelledClone).some(command=>command.includes("'fetch'")),false,'no remote fetch starts after cancellation');
  await assert.rejects(access(join(f.remote,'cancelled')));
  assert.deepEqual(await readdir(f.remote),[]);
});

test('creation validates identity, network URL and destination names before making changes',()=>{
  assert.deepEqual(validateGitIdentity(identity),identity);
  assert.equal(cloneDirectory(identity.url,''),'project');
  assert.equal(cloneDirectory('git@example.test:owner/repo.git',''),'repo');
  for(const changes of [{name:''},{email:'invalid'},{url:'/local/path'},{url:'ext::helper'}])assert.throws(()=>validateGitIdentity({...identity,...changes}));
  for(const directory of ['..','../other','/absolute','nested/project'])assert.throws(()=>cloneDirectory(identity.url,directory));
});

test('a destination created during the local clone is preserved without publishing over it',{ skip: process.platform === 'win32' ? 'POSIX SSH-host fixture' : false }, async t=>{
  const f=await fixture(t),target=join(f.remote,'raced');
  const local:typeof f.local=async(args,signal,report)=>{
    const result=await f.local(args,signal,report);
    if(args[0]==='clone'){await mkdir(target);await writeFile(join(target,'owned'),'keep');}
    return result;
  };
  await assert.rejects(cloneThroughLocalGit(f.transport,{...identity,directory:'raced'},{storagePath:f.storagePath,local}));
  assert.equal(await readFile(join(target,'owned'),'utf8'),'keep');
  assert.deepEqual((await readdir(f.remote)).filter(name=>name.startsWith('.safs-clone-')),[]);
  assert.deepEqual(await readdir(f.storagePath),[]);
});

test('initialization executes at the selected remote directory and preserves existing files',{skip:process.platform==='win32'?'POSIX SSH-host fixture':false},async t=>{
  const f=await fixture(t);
  await writeFile(join(f.remote,'existing.txt'),'keep');
  assert.equal(await initializeRemoteGit(f.transport,identity),f.remote);
  assert.equal(await readFile(join(f.remote,'existing.txt'),'utf8'),'keep');
  assert.equal((await f.git(['-C',f.remote,'config','--local','user.name'])).trim(),identity.name);
  assert.equal((await f.git(['-C',f.remote,'config','--local','user.email'])).trim(),identity.email);
  assert.equal((await f.git(['-C',f.remote,'remote','get-url','origin'])).trim(),identity.url);
  assert.equal((await f.git(['-C',f.remote,'symbolic-ref','--short','HEAD'])).trim(),'main');
  assert.ok(f.commands.some(command=>command.includes("'init'")));
  const before=await readFile(join(f.remote,'.git/config'),'utf8');
  await assert.rejects(initializeRemoteGit(f.transport,{...identity,name:'changed'}),/已属于/);
  assert.equal(await readFile(join(f.remote,'.git/config'),'utf8'),before);
  assert.deepEqual(f.localCommands,[],'initialization never invokes the local network runner');
});
