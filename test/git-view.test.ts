import assert from 'node:assert/strict';
import test from 'node:test';
const vscode = require('vscode');
class Uri {
  constructor(readonly path: string, readonly scheme = 'safs', readonly query = '') {}
  toString() { return `${this.scheme}://dev${this.path}${this.query ? '?' + this.query : ''}`; }
  with(value: Partial<Uri>) { return new Uri(value.path ?? this.path, value.scheme ?? this.scheme, value.query ?? this.query); }
}
class TreeItem { constructor(public label: string, public collapsibleState?: number) {} }
class ThemeIcon { constructor(readonly id: string) {} }
class EventEmitter {
  listeners: Function[] = [];
  event = (callback: Function) => { this.listeners.push(callback); return {dispose() {}}; };
  fire() { this.listeners.forEach(callback => callback()); }
}
Object.assign(vscode, { TreeItem, ThemeIcon, EventEmitter, env:{clipboard:{writeText:async()=>{}}}, commands:{executeCommand:async()=>{}},
  TreeItemCollapsibleState: {None:0,Collapsed:1,Expanded:2},
  Uri: { joinPath: (uri: Uri, ...parts: string[]) => new Uri([uri.path, ...parts].join('/'), uri.scheme) }
});
const { RemoteGitView, gitViewHtml } = require('../src/git/git-view') as typeof import('../src/git/git-view');
const { CommitNode, FileNode, RepositoryNode } = require('../src/git/remote-git-history') as typeof import('../src/git/remote-git-history');
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('Git view uses a strict CSP and packaged scripts/styles', () => {
  const html = gitViewHtml({cspSource:'vscode-resource:',asWebviewUri:(uri:Uri)=>uri.toString()} as any,new Uri('/extension','file') as any);
  assert.match(html,/default-src 'none'/);
  assert.match(html,/script-src 'nonce-[a-f0-9]+'/);
  assert.match(html,/resources\/git-view.css/);
  assert.match(html,/dist\/git-view.js/);
  assert.doesNotMatch(html,/unsafe-inline|unsafe-eval/);
});

test('Git webview validates repository actions, keeps native objects private, and cancels relay work', async () => {
  const posts: any[] = [], executed: any[][] = [], copied: string[] = [], setups: any[] = [];
  let receive!: (message: unknown) => void;
  const emitter = new EventEmitter();
  const uri = new Uri('/placeholder/project');
  const resource = {change:{path:'file.txt',index:' ',working:'M'}};
  const repository: any = {uri,name:'project',queue:Promise.resolve(),count:1,disposed:false,
    syncState:{branch:'main',kind:'tracked',ahead:0,behind:0,upstream:'origin/main'},
    index:{label:'已暂存的更改',staged:true,resourceStates:[]},
    working:{label:'更改',staged:false,resourceStates:[resource]},
    conflicts:{label:'合并冲突',staged:false,resourceStates:[]},
    git:{probe:async()=>undefined,run:async()=> 'refs/heads/main\0main\0*\0\nrefs/remotes/origin/main\0origin/main\0 \0\n'}
  };
  const commit:any = {id:'a'.repeat(40),parents:[],author:'Author',authorEmail:'a@example.test',timestamp:0,refs:[],subject:'<img onerror=alert(1)>',body:''};
  const commitNode = new CommitNode(repository,commit,'已推送');
  const fileNode = new FileNode(repository,commit,{path:'file.txt',status:'A'});
  const controller:any = {
    scanning:false,onDidChangeStatus:emitter.event,onDidChangeRepositories:emitter.event,onDidChangeHistory:emitter.event,
    repositoriesForView:()=>[repository],repository:(key:string)=>key===uri.toString()?repository:undefined,
    execute:async (...args:any[])=>{
      executed.push(args);
      if(args[0]==='fetch')await new Promise<void>((_resolve,reject)=>args[2].addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
    },refresh:async()=>{},cancelScan:()=>{}
  };
  const history:any = {onDidChangeTreeData:emitter.event,getChildren:async(node:any)=>node instanceof RepositoryNode?[commitNode]:[fileNode]};
  Object.assign(vscode.workspace,{workspaceFolders:[{uri,name:'project'}]});
  Object.assign(vscode,{env:{clipboard:{writeText:async(value:string)=>copied.push(value)}}});
  const view:any = {webview:{options:{},cspSource:'vscode-resource:',asWebviewUri:(uri:Uri)=>uri.toString(),postMessage:async(value:any)=>{posts.push(value);return true;},onDidReceiveMessage:(listener:typeof receive)=>{receive=listener;return{dispose(){}};}},onDidDispose:()=>({dispose(){}})};
  const provider = new RemoteGitView(new Uri('/extension','file') as any,controller,history,{root:()=>'/srv/project',setup:async(input,signal)=>{setups.push([input,signal]);}});
  try {
    provider.resolveWebviewView(view);await provider.publish();
    const state=posts.find(post=>post.type==='state');
    assert.equal(state.repositories[0].root,'/srv/project');
    assert.equal(state.repositories[0].branches.length,1);
    assert.equal(state.repositories[0].commits[0].subject,commit.subject);
    assert.equal('git' in state.repositories[0],false);
    receive({type:'action',action:'stage',repository:'foreign',group:'1'});await tick();
    assert.equal(executed.length,0);
    assert.ok(posts.some(post=>post.type==='error'&&post.repository==='foreign'));
    receive({type:'action',action:'stage',repository:uri.toString(),group:'1',path:'missing.txt'});await tick();
    assert.equal(executed.length,0);
    receive({type:'action',action:'stage',repository:uri.toString(),group:'1',path:'file.txt'});await tick();
    assert.equal(executed[0][0],'stage');assert.equal(executed[0][1],resource);
    receive({type:'action',action:'commit',repository:uri.toString(),message:'commit message'});await tick();
    assert.deepEqual(executed.at(-1),['commit',repository,'commit message']);
    receive({type:'action',action:'copyCommit',repository:uri.toString(),commit:commit.id});await tick();
    assert.deepEqual(copied,[commit.id]);
    receive({type:'action',action:'setup',repository:'setup',mode:'init',target:'foreign',name:'a',email:'a@example.test',url:'https://example.test/r.git',directory:''});await tick();
    assert.equal(setups.length,0);
    receive({type:'action',action:'fetch',repository:uri.toString()});await tick();
    receive({type:'action',action:'fetch',repository:uri.toString()});
    assert.equal(executed.filter(args=>args[0]==='fetch').length,1);
    receive({type:'cancel',repository:uri.toString()});await tick();
    assert.equal(executed.at(-1)![2].aborted,true);
    assert.ok(posts.some(post=>post.type==='error'&&post.message.includes('操作已取消')));
  } finally {provider.dispose();}
});
