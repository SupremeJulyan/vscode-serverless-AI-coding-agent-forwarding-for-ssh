import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { shellQuote } from '../shared/shell-quote';
import { RemoteGit, gitCommand, GitResult } from './remote-git';
import { localGitRunner, validateFetchUrl, LocalGitRunner } from './local-git-push';
import { describeFetchFailure } from './local-git-pull';
const t = (message: string) => message;
export interface CloneTransport {
  root: string;
  run(command: string, signal?: AbortSignal): Promise<GitResult>;
  realpath(path: string, signal?: AbortSignal): Promise<string>;
  upload(local: string, remote: string, signal?: AbortSignal): Promise<void>;
  remove(remote: string): Promise<void>;
  publish(source: string, destination: string, signal?: AbortSignal): Promise<void>;
}
export interface CloneOptions {
  storagePath: string; local?: LocalGitRunner; signal?: AbortSignal;
  report?(message: string): void;
}
export interface GitIdentity { name:string; email:string; url:string }
export function validateGitIdentity(input:GitIdentity):GitIdentity {
  const name=input.name.trim(),email=input.email.trim(),url=input.url.trim();
  if(!name||name.length>256||/[<>\x00-\x1f\x7f]/.test(name))throw new Error(t('请输入有效的 Git 用户名'));
  if(!/^[^\s@<>]+@[^\s@<>]+$/.test(email)||/[\x00-\x1f\x7f]/.test(email))throw new Error(t('请输入有效的 Git 邮箱'));
  if(!url||url.length>8192||/[\x00-\x1f\x7f]/.test(url))throw new Error(t('请输入远程仓库链接'));
  validateFetchUrl(url);
  return {name,email,url};
}
export function cloneDirectory(url:string,directory:string):string {
  const guessed=posix.basename(url.includes('://')?new URL(url).pathname:url.replace(/^[^:]+:/,'')).replace(/\.git$/i,'');
  const name=(directory||guessed).trim();
  if(!name||name==='.'||name==='..'||name.length>255||/[\\/\x00-\x1f\x7f]/.test(name))throw new Error(t('克隆目录必须是当前目录下的一个新文件夹名称'));
  return name;
}

/** Initializes only the selected remote working directory; never modifies global Git identity. */
export async function initializeRemoteGit(transport:Pick<CloneTransport,'root'|'run'|'realpath'>,input:GitIdentity,signal?:AbortSignal):Promise<string> {
  const identity=validateGitIdentity(input);
  signal?.throwIfAborted();
  const root=await transport.realpath(transport.root,signal);
  const existing=await transport.run(gitCommand(['-C',root,'rev-parse','--show-toplevel']),signal);
  if(existing.exitCode===0)throw new Error(t('当前目录已属于 Git 仓库，请刷新 Git'));
  if(existing.exitCode!==128||!/not a git repository|不是.*git.*仓库/i.test(existing.stderr+existing.stdout))throw new Error(existing.stderr||t('无法检查当前 Git 目录'));
  const check=await transport.run(`test ! -e ${shellQuote(posix.join(root,'.git'))} && test ! -L ${shellQuote(posix.join(root,'.git'))}`,signal);
  if(check.exitCode!==0)throw new Error(t('当前目录已有 .git，未修改现有仓库'));
  const git=new RemoteGit(command=>transport.run(command,signal));
  await git.run(['init','--initial-branch=main','--',root]);
  for(const [key,value] of [['user.name',identity.name],['user.email',identity.email],['remote.origin.url',identity.url],['remote.origin.fetch','+refs/heads/*:refs/remotes/origin/*'],['branch.main.remote','origin'],['branch.main.merge','refs/heads/main']]) {
    await git.run(['-C',root,'config','--local','--',key,value]);
  }
  return root;
}

/** The network clone runs locally. Only Git objects travel to the remote over existing SFTP. */
export async function cloneThroughLocalGit(transport:CloneTransport,input:GitIdentity & {directory:string},options:CloneOptions):Promise<string> {
  const identity=validateGitIdentity(input),directory=cloneDirectory(identity.url,input.directory),signal=options.signal;
  const local=options.local??localGitRunner();
  const root=await transport.realpath(transport.root,signal),destination=posix.join(root,directory);
  const run=async(command:string,currentSignal=signal)=>{
    const result=await transport.run(command,currentSignal);
    if(result.exitCode!==0)throw new Error(result.stderr.trim()||t('远程克隆准备失败：目标可能已存在'));
    return result.stdout;
  };
  const absent=()=>run(`test ! -e ${shellQuote(destination)} && test ! -L ${shellQuote(destination)}`);
  await absent();
  await mkdir(options.storagePath,{recursive:true,mode:0o700});
  const temporary=await mkdtemp(join(options.storagePath,'clone-'));
  const stage=posix.join(root,'.safs-clone-'+randomUUID());
  let created=false,published=false;
  try {
    const repository=join(temporary,'repository.git'),bundle=join(temporary,'project.bundle');
    options.report?.(t('正在通过本机 Git 克隆项目…'));
    try {await local(['clone','--bare','--no-local','--',identity.url,repository],signal,options.report);}
    catch(error){throw new Error(describeFetchFailure(identity.url,error instanceof Error?error.message:String(error)));}
    const format=(await local(['-C',repository,'rev-parse','--show-object-format'],signal)).trim();
    if(!['sha1','sha256'].includes(format))throw new Error(t('无法识别 Git 对象格式'));
    const heads=(await local(['-C',repository,'for-each-ref','--format=%(refname)','refs/heads/'],signal)).trim().split('\n').filter(Boolean);
    const symbolic=(await local(['-C',repository,'symbolic-ref','HEAD'],signal)).trim();
    const ref=heads.includes(symbolic)?symbolic:heads[0]??symbolic;
    if(!ref.startsWith('refs/heads/'))throw new Error(t('无法识别默认分支'));
    await local(['check-ref-format',ref],signal);
    const branch=ref.slice('refs/heads/'.length);
    await local(['check-ref-format','--branch',branch],signal);
    const refs=(await local(['-C',repository,'for-each-ref','--format=%(refname)'],signal)).trim();
    if(refs)await local(['-C',repository,'bundle','create',bundle,'--all'],signal);
    signal?.throwIfAborted();
    await absent();
    await run(`mkdir -m 700 -- ${shellQuote(stage)}`);created=true;
    const git=new RemoteGit(command=>{
      signal?.throwIfAborted();
      return transport.run(command,signal);
    });
    await git.run(['init',`--object-format=${format}`,`--initial-branch=${branch}`,'--',stage]);
    if(refs){
      const remoteBundle=posix.join(stage,'.git','safs-clone.bundle');
      options.report?.(t('正在通过 SFTP 将项目传入远程目录…'));
      await transport.upload(bundle,remoteBundle,signal);
      await git.run(['-C',stage,'fetch','--no-tags',remoteBundle,'+refs/heads/*:refs/remotes/origin/*','+refs/tags/*:refs/tags/*']);
      if(heads.length)await git.run(['-C',stage,'-c','filter.lfs.smudge=','-c','filter.lfs.process=','-c','filter.lfs.required=false','checkout','-B',branch,`refs/remotes/origin/${branch}`,'--']);
      await transport.remove(remoteBundle);
    }
    for(const [key,value] of [['user.name',identity.name],['user.email',identity.email],['remote.origin.url',identity.url],['remote.origin.fetch','+refs/heads/*:refs/remotes/origin/*'],[`branch.${branch}.remote`,'origin'],[`branch.${branch}.merge`,ref]]) {
      await git.run(['-C',stage,'config','--local','--',key,value]);
    }
    signal?.throwIfAborted();
    if(posix.join(await transport.realpath(root,signal),directory)!==destination)throw new Error(t('克隆目标路径已变化'));
    await absent();
    await transport.publish(stage,destination,signal);
    published=true;
    return destination;
  } finally {
    if(created&&!published)await run(`rm -rf -- ${shellQuote(stage)}`,AbortSignal.timeout(10000)).catch(()=>options.report?.(t('未完成的克隆临时目录清理失败，请检查远程目录')));
    await rm(temporary,{recursive:true,force:true});
  }
}
