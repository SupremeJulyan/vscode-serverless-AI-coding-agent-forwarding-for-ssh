import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { AgentActivityStore } from './agent-activity';

export const agentActivityViewId = 'safs.agentActivity';

export class AgentActivityViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly changeSubscription: { dispose(): void };

  constructor(private readonly store: AgentActivityStore) {
    this.changeSubscription = store.onDidChange((events) => {
      void this.view?.webview.postMessage({ type: 'state', events });
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = activityViewHtml(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const type = (message as { type?: unknown }).type;
      if (type === 'ready') {
        await view.webview.postMessage({
          type: 'state', events: this.store.snapshot(), initial: true
        });
      } else if (type === 'clear') {
        const selected = await vscode.window.showWarningMessage(
          '确定清空当前窗口的 Agent 活动记录吗？',
          { modal: true },
          '清空'
        );
        if (selected === '清空') await this.store.clear();
      }
    });
  }

  dispose(): void {
    this.changeSubscription.dispose();
    this.view = undefined;
  }
}

export function activityViewHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(18).toString('base64');
  return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; padding: 10px; color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background); font: 12px/1.45 var(--vscode-font-family);
    }
    button, select {
      color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
      border: 1px solid var(--vscode-widget-border, transparent); border-radius: 4px;
      font: inherit; min-height: 26px;
    }
    button { cursor: pointer; padding: 3px 8px; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button:focus-visible, select:focus-visible, summary:focus-visible {
      outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
    }
    .status {
      position: relative; overflow: hidden; display: grid; grid-template-columns: 38px 1fr;
      gap: 9px; align-items: center; min-height: 64px; padding: 10px;
      border: 1px solid var(--vscode-widget-border); border-radius: 8px;
      background: var(--vscode-editor-background); margin-bottom: 8px;
    }
    .orb {
      width: 34px; height: 34px; display: grid; place-items: center; border-radius: 50%;
      background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
      font-size: 17px; position: relative;
    }
    .status.running .orb::after {
      content: ''; position: absolute; inset: -4px; border: 2px solid var(--vscode-progressBar-background);
      border-radius: 50%; animation: pulse 1.1s ease-out infinite;
    }
    .status.success .orb { background: var(--vscode-testing-iconPassed, #2ea043); }
    .status.error .orb { background: var(--vscode-testing-iconFailed, #f85149); }
    .status-title { font-weight: 600; }
    .status-detail { color: var(--vscode-descriptionForeground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    @keyframes pulse { from { transform: scale(.8); opacity: .9; } to { transform: scale(1.35); opacity: 0; } }
    .ticker {
      position: relative; min-height: 25px; overflow: hidden; margin-bottom: 8px;
      border-radius: 5px; background: var(--vscode-textBlockQuote-background);
    }
    .ticker.empty::after {
      content: '关键操作会在这里显示'; display: block; padding: 4px 8px;
      color: var(--vscode-descriptionForeground);
    }
    .bullet {
      padding: 4px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      animation: arrive .25s ease-out, leave .3s ease-in 3.7s forwards;
    }
    .bullet.error { color: var(--vscode-errorForeground); }
    @keyframes arrive { from { transform: translateX(28px); opacity: 0; } }
    @keyframes leave { to { transform: translateX(-20px); opacity: 0; } }
    .controls { display: grid; grid-template-columns: 1fr 1fr auto; gap: 5px; margin-bottom: 8px; }
    select { min-width: 0; padding: 2px 4px; }
    .toolbar { display: flex; gap: 5px; margin-bottom: 8px; }
    .toolbar button[aria-pressed="true"] { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .empty-state {
      padding: 18px 8px; text-align: center; color: var(--vscode-descriptionForeground);
      border: 1px dashed var(--vscode-widget-border); border-radius: 7px;
    }
    .timeline { display: grid; gap: 6px; }
    .event, .group {
      border-left: 3px solid var(--vscode-descriptionForeground); border-radius: 5px;
      background: var(--vscode-editor-background); padding: 7px 8px;
    }
    .event.running { border-left-color: var(--vscode-progressBar-background); }
    .event.success { border-left-color: var(--vscode-testing-iconPassed, #2ea043); }
    .event.error, .event.interrupted { border-left-color: var(--vscode-testing-iconFailed, #f85149); }
    .event-head { display: flex; gap: 6px; align-items: baseline; }
    .event-title { font-weight: 600; flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .source { color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); border-radius: 8px; padding: 0 5px; font-size: 10px; }
    .meta, .target { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .target { margin-top: 2px; }
    details { margin-top: 4px; }
    summary { color: var(--vscode-textLink-foreground); cursor: pointer; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 7px; margin: 5px 0 0; }
    dt { color: var(--vscode-descriptionForeground); }
    dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
    .group { border-left-color: var(--vscode-charts-blue, #3794ff); }
    .group-items { display: grid; gap: 5px; margin-top: 5px; }
    .group-item { padding-top: 5px; border-top: 1px solid var(--vscode-widget-border); }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
    }
  </style>
</head>
<body>
  <section id="status" class="status idle" aria-live="polite">
    <div id="orb" class="orb" aria-hidden="true">◇</div>
    <div><div id="statusTitle" class="status-title">等待 Agent 操作</div><div id="statusDetail" class="status-detail">当前远程窗口</div></div>
  </section>
  <div id="ticker" class="ticker empty" aria-live="polite"></div>
  <div class="controls">
    <select id="category" aria-label="按操作类型筛选">
      <option value="all">全部类型</option><option value="read">读取/搜索</option>
      <option value="write">修改</option><option value="command">命令</option><option value="transfer">传输</option>
    </select>
    <select id="eventStatus" aria-label="按执行状态筛选">
      <option value="all">全部状态</option><option value="running">执行中</option>
      <option value="success">成功</option><option value="error">失败/中断</option>
    </select>
    <button id="clear" type="button" title="清空当前窗口记录">清空</button>
  </div>
  <div class="toolbar"><button id="pause" type="button" aria-pressed="false">暂停弹幕</button></div>
  <main id="timeline" class="timeline"></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const timeline = document.getElementById('timeline');
    const ticker = document.getElementById('ticker');
    const statusCard = document.getElementById('status');
    const statusTitle = document.getElementById('statusTitle');
    const statusDetail = document.getElementById('statusDetail');
    const orb = document.getElementById('orb');
    const categoryFilter = document.getElementById('category');
    const statusFilter = document.getElementById('eventStatus');
    const pauseButton = document.getElementById('pause');
    let events = [];
    let paused = false;
    let statusTimer;
    const seenStatus = new Map();
    const labels = {
      current_remote_file: '查看当前文件', remote_list: '列出目录', remote_read: '读取文件',
      remote_read_many: '批量读取', remote_output: '续读命令输出', remote_search: '搜索远程代码',
      remote_edit: '编辑文件', remote_write: '写入文件', remote_delete: '删除路径',
      remote_chmod: '修改权限', remote_move: '移动路径', remote_upload: '上传文件',
      remote_download: '下载文件', run_remote_command: '执行远程命令'
    };
    const summaryLabels = {
      path: '路径', paths: '路径', sourcePath: '来源', targetPath: '目标', remoteDirectory: '远程目录',
      remotePath: '远程路径', localPath: '本地路径', localPaths: '本地路径', remoteCwd: '工作目录',
      query: '查询', command: '命令', editCount: '编辑项', contentBytes: '写入字节', requestCount: '请求数',
      recursive: '递归', overwrite: '覆盖', mode: '模式', exitCode: '退出码', bytes: '字节',
      completed: '已完成', discovered: '已发现', truncated: '结果截断', retentionTruncated: '保留截断',
      resultStatus: '结果'
    };
    function textElement(tag, className, value) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      element.textContent = value;
      return element;
    }
    function label(event) { return labels[event.toolName] || event.toolName; }
    function target(event) {
      const value = event.summary || {};
      const targetValue = value.path || value.targetPath || value.remotePath || value.remoteDirectory
        || value.remoteCwd || value.query || value.command
        || (Array.isArray(value.paths) ? value.paths[0] : '') || event.workspaceRoot;
      return typeof targetValue === 'string' ? targetValue : '';
    }
    function statusText(value) {
      if (value === 'running') return '执行中';
      if (value === 'success') return '成功';
      if (value === 'interrupted') return '已中断';
      return '失败';
    }
    function formatDuration(event) {
      if (typeof event.durationMs !== 'number') return '';
      return event.durationMs < 1000 ? event.durationMs + ' ms' : (event.durationMs / 1000).toFixed(1) + ' s';
    }
    function formatTime(value) {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    }
    function detailList(event) {
      const details = document.createElement('details');
      details.appendChild(textElement('summary', '', '查看详情'));
      const list = document.createElement('dl');
      const values = Object.assign({}, event.summary || {});
      if (event.error) values.error = event.error;
      Object.entries(values).forEach(function(entry) {
        const key = entry[0], value = entry[1];
        if (value === undefined) return;
        list.appendChild(textElement('dt', '', summaryLabels[key] || (key === 'error' ? '错误' : key)));
        list.appendChild(textElement('dd', '', Array.isArray(value) ? value.join('\\n') : String(value)));
      });
      details.appendChild(list);
      return details;
    }
    function eventCard(event, compact) {
      const card = document.createElement('article');
      card.className = 'event ' + event.status + (compact ? ' group-item' : '');
      const head = textElement('div', 'event-head', '');
      head.appendChild(textElement('span', 'event-title', label(event)));
      head.appendChild(textElement('span', 'source', event.source.toUpperCase()));
      card.appendChild(head);
      const destination = target(event);
      if (destination) card.appendChild(textElement('div', 'target', destination));
      const meta = [event.agentName, statusText(event.status), formatDuration(event), formatTime(event.startedAt)].filter(Boolean).join(' · ');
      card.appendChild(textElement('div', 'meta', meta));
      if (Object.keys(event.summary || {}).length || event.error) card.appendChild(detailList(event));
      return card;
    }
    function filtered() {
      const category = categoryFilter.value;
      const state = statusFilter.value;
      return events.filter(function(event) {
        if (category !== 'all' && event.category !== category) return false;
        if (state === 'error') return event.status === 'error' || event.status === 'interrupted';
        return state === 'all' || event.status === state;
      });
    }
    function groups(values) {
      const result = [];
      values.slice().sort(function(a, b) { return Date.parse(a.startedAt) - Date.parse(b.startedAt); }).forEach(function(event) {
        const previous = result[result.length - 1];
        const items = previous && previous.items;
        const last = items && items[items.length - 1];
        if (event.category === 'read' && event.status === 'success'
            && last && last.category === 'read' && last.status === 'success'
            && last.agentName === event.agentName && last.toolName === event.toolName
            && Date.parse(event.startedAt) - Date.parse(last.startedAt) <= 2000) {
          items.push(event);
        } else {
          result.push({ items: [event] });
        }
      });
      return result.reverse();
    }
    function render() {
      timeline.replaceChildren();
      const values = filtered();
      if (!values.length) {
        timeline.appendChild(textElement('div', 'empty-state', events.length ? '当前筛选条件下没有活动' : '暂无 Agent 远程操作。启用转发后，MCP 和 CLI 操作会显示在这里。'));
        return;
      }
      groups(values).forEach(function(group) {
        if (group.items.length === 1) {
          timeline.appendChild(eventCard(group.items[0], false));
          return;
        }
        const wrapper = document.createElement('details');
        wrapper.className = 'group';
        const first = group.items[0];
        wrapper.appendChild(textElement('summary', '', first.agentName + ' · ' + label(first) + ' × ' + group.items.length));
        const list = textElement('div', 'group-items', '');
        group.items.slice().reverse().forEach(function(event) { list.appendChild(eventCard(event, true)); });
        wrapper.appendChild(list);
        timeline.appendChild(wrapper);
      });
    }
    function setStatus(kind, title, detail) {
      clearTimeout(statusTimer);
      statusCard.className = 'status ' + kind;
      statusTitle.textContent = title;
      statusDetail.textContent = detail || '当前远程窗口';
      orb.textContent = kind === 'running' ? '↻' : kind === 'success' ? '✓' : kind === 'error' ? '!' : '◇';
      if (kind === 'success' || kind === 'error') {
        statusTimer = setTimeout(function() { setStatus('idle', '等待 Agent 操作', '当前远程窗口'); }, 2000);
      }
    }
    function bullet(event) {
      if (paused) return;
      const important = event.category !== 'read' || event.status === 'error' || event.status === 'interrupted';
      if (!important) return;
      ticker.classList.remove('empty');
      while (ticker.children.length >= 3) ticker.firstElementChild.remove();
      const message = event.agentName + ' · ' + label(event) + (target(event) ? ' · ' + target(event) : '')
        + (event.status === 'error' || event.status === 'interrupted' ? ' · ' + statusText(event.status) : '');
      const item = textElement('div', 'bullet ' + (event.status === 'error' || event.status === 'interrupted' ? 'error' : ''), message);
      ticker.appendChild(item);
      setTimeout(function() {
        item.remove();
        if (!ticker.children.length) ticker.classList.add('empty');
      }, 4100);
    }
    function acceptState(message) {
      const incoming = Array.isArray(message.events) ? message.events : [];
      let completedEvent;
      if (!message.initial) {
        incoming.forEach(function(event) {
          const previous = seenStatus.get(event.id);
          if (previous !== event.status) {
            if (event.status === 'running') {
              bullet(event);
            } else if (previous === 'running') {
              if (!completedEvent || Date.parse(event.completedAt || '') >= Date.parse(completedEvent.completedAt || '')) {
                completedEvent = event;
              }
              if (event.status !== 'success') bullet(event);
            }
          }
        });
      }
      seenStatus.clear();
      incoming.forEach(function(event) { seenStatus.set(event.id, event.status); });
      events = incoming;
      const running = events.slice().reverse().find(function(event) { return event.status === 'running'; });
      if (running) {
        setStatus('running', running.agentName + ' 正在' + label(running), target(running));
      } else if (completedEvent) {
        setStatus(completedEvent.status === 'success' ? 'success' : 'error',
          label(completedEvent) + statusText(completedEvent.status), target(completedEvent));
      } else if (!events.length) {
        setStatus('idle', '等待 Agent 操作', '当前远程窗口');
      }
      render();
    }
    window.addEventListener('message', function(event) {
      if (event.data && event.data.type === 'state') acceptState(event.data);
    });
    categoryFilter.addEventListener('change', render);
    statusFilter.addEventListener('change', render);
    pauseButton.addEventListener('click', function() {
      paused = !paused;
      pauseButton.setAttribute('aria-pressed', String(paused));
      pauseButton.textContent = paused ? '恢复弹幕' : '暂停弹幕';
    });
    document.getElementById('clear').addEventListener('click', function() { vscode.postMessage({ type: 'clear' }); });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
