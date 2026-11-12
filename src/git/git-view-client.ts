import {
  faCodeBranch, faClockRotateLeft, faChevronDown, faChevronRight, faRotateRight,
  faPlus, faMinus, faRotateLeft, faArrowDown, faArrowUp, faCheck,
  faXmark, faFileCode, faStop, faSpinner
} from '@fortawesome/free-solid-svg-icons';
import { faFile, faCircleCheck } from '@fortawesome/free-regular-svg-icons';
import type { IconDefinition } from '@fortawesome/fontawesome-common-types';

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void; getState(): Partial<Saved> | undefined; setState(state: Saved): void;
};
interface Change { path: string; index: string; working: string }
interface Commit { id: string; subject: string; author: string; timestamp: number; status: string; sync: string; files?: Array<{path: string; status: string}> }
interface Repo {
  id: string; name: string; root: string; branch: string; count: number; sync: string; syncTooltip: string;
  busy: boolean; error?: string; inspectorError?: string;
  groups: Array<{id: string; title: string; staged: boolean; conflict: boolean; changes: Change[]}>;
  commits: Commit[]; branches: Array<{name: string; current: boolean}>;
}
interface State { repositories: Repo[]; scanning: boolean; setupBusy: boolean; targets: Array<{id: string; name: string; root: string}> }
interface Saved { collapsed: Record<string, boolean>; tabs: Record<string, string>; drafts: Record<string, string>; expanded: Record<string, boolean> }
const vscode = acquireVsCodeApi();
const saved = vscode.getState() ?? {};
const preferences: Saved = { collapsed: saved.collapsed ?? {}, tabs: saved.tabs ?? {}, drafts: saved.drafts ?? {}, expanded: saved.expanded ?? {} };
let state: State = { repositories: [], targets: [], scanning: true, setupBusy: false };
const pending: Record<string, boolean> = {};
const progress: Record<string, string> = {};
const pendingActions: Record<string, string> = {};
const errors: Record<string, string> = {};
const notices: Record<string, string> = {};
let setup: {mode: 'init'|'clone'; target: string; name: string; email: string; url: string; directory: string} | undefined;
const root = document.getElementById('git-view')!;
const persist = () => vscode.setState(preferences);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string | number): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function icon(definition: IconDefinition): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const [width, height, , , paths] = definition.icon;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'fa-icon');
  for (const d of Array.isArray(paths) ? paths : [paths]) {
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', d); path.setAttribute('fill', 'currentColor'); svg.append(path);
  }
  return svg;
}
function button(label: string, image: IconDefinition | undefined, click: () => void, className = ''): HTMLButtonElement {
  const node = el('button', className); node.type = 'button';
  if (image) node.append(icon(image)); if (label) node.append(document.createTextNode(label));
  node.addEventListener('click', click); return node;
}
function action(actionName: string, repository: string, extra: Record<string, unknown> = {}): void {
  if (pending[repository]) return;
  pending[repository] = true; pendingActions[repository] = actionName; delete errors[repository]; delete notices[repository]; render();
  vscode.postMessage({ type: 'action', action: actionName, repository, ...extra });
}
function errorBox(message: string, key: string): HTMLElement {
  const box = el('div', 'error'); box.setAttribute('role', 'alert'); box.append(el('span', '', message));
  const close = button('', faXmark, () => { delete errors[key]; vscode.postMessage({type: 'dismiss', repository: key}); render(); }, 'icon-button dismiss-error');
  close.title = '关闭'; close.setAttribute('aria-label', '关闭 Git 错误提示'); box.append(close); return box;
}
function renderCommit(repo: Repo, commit: Commit): HTMLElement {
  const entry = el('div', 'git-history-entry');
  const key = repo.id + ':' + commit.id, expanded = preferences.expanded[key] === true;
  const item = button('', undefined, () => {
    preferences.expanded[key] = !expanded; persist();
    if (!expanded && !commit.files) action('files', repo.id, { commit: commit.id }); else render();
  }, 'git-history-item');
  item.title = commit.id; item.setAttribute('aria-expanded', String(expanded));
  const subject = el('span', 'commit-subject'); subject.append(icon(expanded ? faChevronDown : faChevronRight), document.createTextNode(commit.subject || commit.id.slice(0, 8)));
  const meta = el('span', 'commit-meta');
  meta.append(el('code', '', commit.id.slice(0, 8)), document.createTextNode(` · ${commit.author} · ${new Date(commit.timestamp * 1000).toLocaleDateString()}`));
  const sync = el('span', 'commit-sync', commit.status);
  sync.dataset.sync = commit.sync;
  sync.title = '基于最近已知的上游记录；提取后可检查上游的新提交。'; meta.append(sync); item.append(subject, meta);
  item.addEventListener('contextmenu', event => {
    event.preventDefault(); root.querySelectorAll('.commit-context').forEach(menu => menu.remove());
    const menu = el('div', 'commit-context');
    menu.append(button('复制提交 ID', undefined, () => { action('copyCommit', repo.id, {commit: commit.id}); menu.remove(); })); entry.append(menu);
  });
  entry.append(item);
  if (expanded) {
    const files = el('div', 'commit-files');
    if (!commit.files) files.append(el('div', 'repository-clean', '正在读取提交记录…'));
    else if (!commit.files.length) files.append(el('div', 'repository-clean', '此提交没有文件改动'));
    else for (const file of commit.files) {
      const row = button('', faFile, () => action('openCommitFile', repo.id, { commit: commit.id, path: file.path }), 'file-row');
      row.title = file.path; row.append(el('span', 'file-name', file.path)); files.append(row);
    }
    entry.append(files);
  }
  return entry;
}
function renderRepo(repo: Repo): HTMLElement {
  const section = el('section', 'git-repository');
  const expanded = !preferences.collapsed[repo.id], busy = pending[repo.id] || repo.busy;
  const heading = button('', undefined, () => { preferences.collapsed[repo.id] = expanded; persist(); render(); }, 'repository-heading');
  heading.title = repo.root; heading.setAttribute('aria-expanded', String(expanded));
  heading.append(icon(expanded ? faChevronDown : faChevronRight), icon(faCodeBranch), el('span', 'file-name', repo.name), el('span', 'count', repo.count));
  section.append(heading); if (!expanded) return section;
  const branch = el('div', 'repository-path'); branch.append(icon(faCodeBranch), document.createTextNode(' ' + repo.branch));
  const sync = el('div', 'repository-path', repo.sync); sync.title = repo.syncTooltip;
  section.append(el('div', 'repository-path', repo.root), branch, sync);
  if (repo.inspectorError) section.append(errorBox(repo.inspectorError, repo.id));
  const tabs = el('div', 'git-inspector-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Git 信息');
  const tab = preferences.tabs[repo.id] ?? 'history';
  for (const [name, label, image, count] of [['history', '提交记录', faClockRotateLeft, repo.commits.length], ['branches', '分支', faCodeBranch, repo.branches.length]] as const) {
    const tabButton = button(label, image, () => { preferences.tabs[repo.id] = name; persist(); render(); }, tab === name ? 'selected' : '');
    tabButton.setAttribute('role', 'tab'); tabButton.setAttribute('aria-selected', String(tab === name)); tabButton.append(el('span', 'count', count)); tabs.append(tabButton);
  }
  section.append(tabs);
  const inspector = el('div', 'git-inspector');
  if (tab === 'history') {
    if (!repo.commits.length) inspector.append(el('div', 'repository-clean', '还没有提交记录'));
    for (const commit of repo.commits) inspector.append(renderCommit(repo, commit));
  } else {
    if (!repo.branches.length) inspector.append(el('div', 'repository-clean', '没有可切换的本地分支'));
    for (const branch of repo.branches) {
      const row = el('div', 'git-branch-item'); row.append(icon(branch.current ? faCheck : faCodeBranch), el('span', 'file-name', branch.name));
      if (branch.current) row.append(el('span', 'branch-current', '当前'));
      else { const switchButton = button('切换', undefined, () => action('branch', repo.id, {branch: branch.name})); switchButton.disabled = busy; row.append(switchButton); }
      inspector.append(row);
    }
    inspector.append(el('small', 'git-inspector-hint', '仅列出本地分支。切换时不会自动还原未提交改动。'));
  }
  section.append(inspector);
  const relay = el('div', 'git-relay');
  for (const [name, label, image, title] of [['fetch', '提取', faRotateRight, '提取上游状态，不修改工作区'], ['pull', '拉取', faArrowDown, '拉取上游更新，只允许快进合并'], ['push', '推送', faArrowUp, '推送当前分支到上游，不强制覆盖']] as const) {
    const node = button(label, image, () => action(name, repo.id)); node.disabled = busy || state.scanning; node.title = title; relay.append(node);
  }
  section.append(relay);
  if (busy && ['fetch','pull','push'].includes(pendingActions[repo.id])) {
    const row = el('div', 'git-relay'); row.setAttribute('role', 'status');
    const text = el('span', '', progress[repo.id] || '正在执行 Git 操作…'); text.append(icon(faSpinner));
    row.append(text, button('取消', undefined, () => vscode.postMessage({type: 'cancel', repository: repo.id}))); section.append(row);
  }
  const commit = el('div', 'git-commit'); const draft = el('textarea'); draft.rows = 2; draft.dataset.focus = 'draft:' + repo.id;
  draft.placeholder = '提交说明（只提交已暂存更改）'; draft.setAttribute('aria-label', '提交说明：' + repo.name); draft.value = preferences.drafts[repo.id] ?? ''; draft.disabled = busy;
  const submit = button('提交', faCheck, () => action('commit', repo.id, {message: draft.value}));
  submit.disabled = busy || !draft.value.trim(); submit.title = repo.groups[0]?.changes.length ? '提交已暂存更改' : '请先暂存需要提交的更改';
  draft.addEventListener('input', () => { preferences.drafts[repo.id] = draft.value; persist(); submit.disabled = busy || !draft.value.trim(); });
  commit.append(draft, submit); section.append(commit);
  if (repo.count) {
    const all = el('div', 'git-actions');
    for (const [name, label, image, group] of [['stage', '全部暂存', faPlus, 1], ['unstage', '全部取消暂存', faMinus, 0], ['discard', '全部还原', faRotateLeft, 1]] as const) {
      const node = button(label, image, () => action(name, repo.id, {group: String(group)}), name === 'discard' ? 'discard-action' : ''); node.disabled = busy || !repo.groups[group]?.changes.length; all.append(node);
    }
    section.append(all);
  }
  if (notices[repo.id]) { const notice = el('div','git-success'); notice.setAttribute('role','status'); notice.append(icon(faCircleCheck), document.createTextNode(notices[repo.id])); section.append(notice); }
  if (errors[repo.id] || repo.error) section.append(errorBox(errors[repo.id] || repo.error!, repo.id));
  for (const group of repo.groups) {
    if (!group.changes.length) continue;
    const changes = el('section'); const title = el('div', 'git-group-heading'); title.append(el('span', '', group.title), el('span', 'count', group.changes.length)); changes.append(title);
    for (const change of group.changes) {
      const row = el('div', 'git-change');
      const open = button('', faFileCode, () => action('openChange', repo.id, { group: group.id, path: change.path }), 'file-row');
      open.title = change.path; open.append(el('span', 'file-name', change.path));
      const status = el('span', 'git-status', group.staged ? change.index : change.working);
      if (change.index === '?' || change.index === 'A') status.classList.add('added'); if (change.index === 'D' || change.working === 'D') status.classList.add('deleted'); open.append(status); row.append(open);
      const stage = button('', group.staged ? faMinus : faPlus, () => action(group.staged ? 'unstage' : 'stage', repo.id, {group: group.id, path: change.path}), 'icon-button git-change-action');
      stage.title = (group.staged ? '取消暂存：' : '暂存：') + change.path; stage.disabled = busy; row.append(stage);
      if (!group.staged && !group.conflict) { const discard = button('', faRotateLeft, () => action('discard', repo.id, {group: group.id, path: change.path}), 'icon-button git-change-action discard-action'); discard.title = '还原未暂存更改：' + change.path; discard.disabled = busy; row.append(discard); }
      changes.append(row);
    }
    section.append(changes);
  }
  if (!repo.count && !repo.error) { const clean = el('div', 'repository-clean'); clean.append(icon(faCircleCheck), document.createTextNode(' 没有变更')); section.append(clean); }
  return section;
}
function renderSetup(): HTMLElement {
  const form = el('form', 'git-setup-form'); const values = setup!; const busy = pending.setup || state.setupBusy;
  form.append(el('strong', '', values.mode === 'init' ? '初始化 Git' : '克隆 Git 项目'));
  const target = state.targets.find(target => target.id === values.target) ?? state.targets[0];
  const targetRow = el('div', 'git-setup-target'); targetRow.append(el('span', '', '目标目录'), el('code', '', target?.root ?? '远程工作区已关闭')); form.append(targetRow);
  if (state.targets.length > 1) {
    const select = el('select'); for (const target of state.targets) { const option = el('option', '', target.name); option.value = target.id; select.append(option); }
    select.value = values.target; select.disabled = busy; select.addEventListener('change', () => { values.target = select.value; render(); }); form.append(select);
  }
  for (const [field, title] of [['name', '用户名'], ['email', '邮箱'], ['url', '远程链接'], ...(values.mode === 'clone' ? [['directory', '新文件夹名称']] : [])] as Array<[keyof Pick<typeof values,'name'|'email'|'url'|'directory'>, string]>) {
    const label = el('label', '', title), input = el('input'); input.name = field; input.value = values[field]; input.dataset.focus = 'setup:' + field; input.autocomplete = 'off'; input.disabled = busy;
    input.type = field === 'email' ? 'email' : 'text'; input.required = field !== 'directory'; input.placeholder = field === 'url' ? 'https://host/owner/project.git' : field === 'directory' ? '留空使用仓库名称' : '';
    input.addEventListener('input', () => { values[field] = input.value; submit.disabled = busy || !values.name.trim() || !values.email.trim() || !values.url.trim(); }); label.append(input); form.append(label);
  }
  form.append(el('small', 'git-setup-hint', values.mode === 'init' ? '在当前目录初始化，仅为此仓库保存用户名、邮箱和 origin。' : '通过本机 Git 和凭据克隆，保存到当前目录下的新文件夹。'));
  if (errors.setup) form.append(errorBox(errors.setup, 'setup'));
  if (busy) form.append(el('div', 'git-notice', progress.setup || '正在准备 Git…'));
  const actions = el('div', 'git-setup-actions');
  const submit = button(values.mode === 'init' ? '初始化' : '克隆', undefined, () => {}); submit.type = 'submit'; submit.disabled = busy || !values.name.trim() || !values.email.trim() || !values.url.trim();
  const cancel = button(busy ? '取消操作' : '取消', undefined, () => { if (busy) vscode.postMessage({type:'cancel',repository:'setup'}); else { setup = undefined; render(); } });
  actions.append(submit, cancel); form.append(actions);
  form.addEventListener('submit', event => { event.preventDefault(); if (form.reportValidity()) action('setup', 'setup', {...values}); });
  return form;
}
function render(): void {
  const focused = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
  const focusKey = focused?.dataset.focus, start = focused?.selectionStart, end = focused?.selectionEnd;
  const scroll = window.scrollY;
  root.replaceChildren();
  const heading = el('div', 'section-heading'), title = el('span'); title.append(icon(faCodeBranch), document.createTextNode(' 源代码管理'));
  const scanning = state.scanning || pending.scan;
  const refresh = button('', scanning ? faStop : faRotateRight, () => scanning ? vscode.postMessage({type:'cancel',repository:'scan'}) : action('refresh','scan'), 'icon-button');
  refresh.title = scanning ? '取消 Git 扫描' : '重新扫描当前目录中的 Git 仓库'; refresh.setAttribute('aria-label', refresh.title); heading.append(title, refresh); root.append(heading);
  if (scanning) root.append(el('div', 'git-notice', '正在扫描 Git 仓库…'));
  if (errors.scan) root.append(errorBox(errors.scan, 'scan'));
  const tree = el('div', 'tree git-tree'); for (const repo of state.repositories) tree.append(renderRepo(repo));
  if (!scanning && !state.repositories.length && !setup) {
    const empty = el('div', 'empty-state compact'); empty.append(icon(faCodeBranch), el('span', '', state.targets.length ? '当前目录尚未发现 Git 仓库' : '请先打开 SAFS 远程工作区'));
    if (state.targets.length) {
      const actions = el('div', 'git-setup-actions');
      for (const [mode, label] of [['init', '初始化 Git'], ['clone', '克隆 Git 项目']] as const) actions.append(button(label, undefined, () => { setup = {mode,target:state.targets[0].id,name:'',email:'',url:'',directory:''}; render(); }));
      empty.append(actions);
    }
    tree.append(empty);
  }
  if (setup) tree.append(renderSetup()); root.append(tree);
  if (focusKey) {
    const next = Array.from(root.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('[data-focus]')).find(node => node.dataset.focus === focusKey);
    if (next && !next.disabled) { next.focus({preventScroll:true}); try { next.setSelectionRange(start ?? 0, end ?? 0); } catch {} }
  }
  window.scrollTo(0, scroll);
}
window.addEventListener('message', event => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;
  if (message.type === 'state') { state = message; render(); }
  else if (message.type === 'busy') { pending[message.repository] = message.busy; if (message.action) pendingActions[message.repository] = message.action; if (!message.busy) delete progress[message.repository]; render(); }
  else if (message.type === 'error') { errors[message.repository ?? 'scan'] = String(message.message); render(); }
  else if (message.type === 'progress') { progress[message.repository] = String(message.message); render(); }
  else if (message.type === 'completed') {
    const success: Record<string,string> = {commit:'已提交',stage:'已暂存',unstage:'已取消暂存',discard:'已还原未暂存更改',fetch:'提取完成',pull:'拉取完成',push:'推送完成',branch:'已切换分支'};
    if (success[message.action]) notices[message.repository] = success[message.action];
    if (message.action === 'commit') { preferences.drafts[message.repository] = ''; persist(); }
    if (message.action === 'setup') setup = undefined;
    render();
  }
});
document.addEventListener('click', event => {
  root.querySelectorAll('.commit-context').forEach(menu => { if (!menu.contains(event.target as Node)) menu.remove(); });
});
render(); vscode.postMessage({ type: 'ready' });
