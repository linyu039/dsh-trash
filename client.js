/**
 * Client half of the Trash (垃圾桶) plugin.
 *
 * Three ways in, one page:
 *   - the sidebar's global panel row (a trash icon beside Plugins),
 *   - a hover control at the end of every Session row,
 *   - a row in every Session's "..." menu.
 *
 * All three select the `main` panel keyed `trash`, so the Trash renders as a
 * real page: a list of every stored Session with its size and state, batch
 * selection, "delete the session file" and "clear the conversation content".
 * Mutating operations go through the plugin's own same-origin Host routes; the
 * page re-reads the Host listing afterwards instead of guessing.
 */
window.__ModuleLoader__.load({
  id: 'dsh-trash',
  factory(require) {
    const React = require('react')
    const { useEffect, useMemo, useRef, useState, useSyncExternalStore } = React
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'trash'
    /** The sidebar panel row id and the `main` panel key this page owns. */
    const PANEL_ID = 'trash'

    const zh = {
      'nav': '垃圾桶',
      'page.title': '垃圾桶',
      'page.subtitle': '管理本机保存的会话记录。删除会直接改写磁盘上的会话文件，无法撤销。',
      'page.storage': '存放位置：{path}',
      'page.refresh': '刷新',
      'page.search': '筛选会话（标题、目录或 ID）',
      'summary': '共 {count} 个会话 · 占用 {size} · 使用中 {live} 个 · 已归档 {archived} 个',
      'selection.count': '已选 {count} 项',
      'action.selectAll': '全选可处理项',
      'action.selectNone': '取消全选',
      'action.deleteSelected': '删除选中',
      'action.clearSelected': '清空选中内容',
      'action.deleteAll': '删除全部会话',
      'action.clearAll': '清空全部内容',
      'row.untitled': '未命名会话',
      'row.live': '使用中',
      'row.archived': '已归档',
      'row.seeded': '派生会话',
      'row.events': '{count} 条事件',
      'menu.open': '移入垃圾桶',
      'row.clear': '清空内容',
      'row.delete': '删除文件',
      'row.clearTitle': '清空这个会话的对话内容，保留会话条目',
      'row.deleteTitle': '永久删除这个会话的会话文件',
      'row.liveClearHint': '该会话正在使用：会先停止它当前的工作，再清空全部内容',
      'row.liveDeleteHint': '该会话正在使用：会先停止它当前的工作，再直接删除',
      'row.seededHint': '派生会话继承了父会话的种子内容，只能删除，不能清空',
      'row.checkbox': '选择 {title}',
      'empty.title': '垃圾桶是空的',
      'empty.desc': '当前没有保存到磁盘的会话记录。',
      'empty.filter': '没有匹配的会话。',
      'loading': '正在读取会话记录…',
      'error.title': '无法读取会话记录',
      'confirm.delete.title': '永久删除会话文件？',
      'confirm.delete.desc': '将删除 {count} 个会话在磁盘上的记录，删除后无法恢复。',
      'confirm.clear.title': '清空对话内容？',
      'confirm.clear.desc': '将清空 {count} 个会话的全部消息，只保留会话条目本身。操作无法撤销。',
      'confirm.list': '目标会话：',
      'confirm.more': '以及另外 {count} 个会话',
      'confirm.cancel': '取消',
      'confirm.delete': '永久删除',
      'confirm.clear': '清空内容',
      'confirm.busy': '正在处理…',
      'confirm.cascade': '一并删除 {count} 个派生会话',
      'confirm.cascadeNotice': '其中 {count} 个会话还包含派生会话（分叉或子代理），继续会一并删除。',
      'confirm.liveNotice': '有 {count} 个会话正在使用中，会先停止它们当前的工作。',
      'notice.deleted': '已删除 {count} 个会话。',
      'notice.cleared': '已清空 {count} 个会话的内容。',
      'notice.forced': '已停止 {count} 个正在运行的会话并完成处理。',
      'notice.partial': '完成 {ok} 项，{failed} 项未处理。',
      'notice.failed': '处理失败：{message}',
      'notice.close': '知道了',
      'error.live': '该会话正在打开或运行中，请先切换到其它会话。',
      'error.busy': '会话文件仍被占用，请稍后再试一次。',
      'error.unknown': '会话不存在或已被删除。',
      'error.children': '该会话存在派生会话（分叉或子代理）。',
      'error.childrenLive': '派生会话中有正在打开的会话。',
      'error.seeded': '派生会话只能删除，不能清空。',
      'error.storage': '无法定位会话存储目录。',
      'error.unsupported': '当前运行时无法改写压缩格式的会话日志，请改用删除文件。',
      'error.forbidden': '请求被拒绝：只允许本机 GUI 发起操作。',
      'error.method': '请求方式错误。',
      'error.badRequest': '请求参数无效。',
      'error.network': '无法连接到 Host。',
      'error.render': '垃圾桶页面渲染出错',
      'error.runtime': '垃圾桶还没准备好',
      'error.runtimeHint': '插件运行时没有挂载到这里，重启 DSH 后再打开这个页面。',
    }

    const en = {
      'nav': 'Trash',
      'page.title': 'Trash',
      'page.subtitle': 'Manage the Session records stored on this machine. Deleting rewrites the session files on disk and cannot be undone.',
      'page.storage': 'Stored at {path}',
      'page.refresh': 'Refresh',
      'page.search': 'Filter sessions (title, directory, or id)',
      'summary': '{count} sessions · {size} used · {live} live · {archived} archived',
      'selection.count': '{count} selected',
      'action.selectAll': 'Select all',
      'action.selectNone': 'Clear selection',
      'action.deleteSelected': 'Delete selected',
      'action.clearSelected': 'Clear selected',
      'action.deleteAll': 'Delete every session',
      'action.clearAll': 'Clear every session',
      'row.untitled': 'Untitled session',
      'row.live': 'In use',
      'row.archived': 'Archived',
      'row.seeded': 'Derived',
      'row.events': '{count} events',
      'menu.open': 'Open in Trash',
      'row.clear': 'Clear content',
      'row.delete': 'Delete file',
      'row.clearTitle': 'Clear this session’s messages and keep the session itself',
      'row.deleteTitle': 'Permanently delete this session’s stored file',
      'row.liveClearHint': 'This session is in use: its running work is stopped first, then every message is cleared',
      'row.liveDeleteHint': 'This session is in use: its running work is stopped first, then the file is deleted',
      'row.seededHint': 'A derived session inherits a seed prefix from its parent, so it can only be deleted.',
      'row.checkbox': 'Select {title}',
      'empty.title': 'The trash is empty',
      'empty.desc': 'No Session record is stored on disk.',
      'empty.filter': 'No session matches the filter.',
      'loading': 'Reading session records…',
      'error.title': 'Cannot read session records',
      'confirm.delete.title': 'Permanently delete session files?',
      'confirm.delete.desc': 'The stored records of {count} sessions will be deleted. This cannot be undone.',
      'confirm.clear.title': 'Clear the conversation content?',
      'confirm.clear.desc': 'Every message of {count} sessions will be cleared; only the session entries stay. This cannot be undone.',
      'confirm.list': 'Target sessions:',
      'confirm.more': 'and {count} more',
      'confirm.cancel': 'Cancel',
      'confirm.delete': 'Delete permanently',
      'confirm.clear': 'Clear content',
      'confirm.busy': 'Working…',
      'confirm.cascade': 'Delete {count} derived sessions too',
      'confirm.cascadeNotice': '{count} of them still have derived sessions (forks or subagents); continuing deletes those too.',
      'confirm.liveNotice': '{count} live sessions will have their running work stopped first.',
      'notice.deleted': 'Deleted {count} sessions.',
      'notice.cleared': 'Cleared the content of {count} sessions.',
      'notice.forced': 'Stopped {count} running sessions and finished the job.',
      'notice.partial': '{ok} done, {failed} left untouched.',
      'notice.failed': 'Failed: {message}',
      'notice.close': 'Dismiss',
      'error.live': 'This session is open or running. Switch to another session first.',
      'error.busy': 'The session file is still held open; try again in a moment.',
      'error.unknown': 'The session no longer exists.',
      'error.children': 'This session still has derived sessions (forks or subagents).',
      'error.childrenLive': 'A derived session is open or running.',
      'error.seeded': 'A derived session can only be deleted, not cleared.',
      'error.storage': 'The session storage directory could not be resolved.',
      'error.unsupported': 'This runtime cannot rewrite the compressed session log; delete the file instead.',
      'error.forbidden': 'Request rejected: this operation is only allowed from the local GUI.',
      'error.method': 'Wrong request method.',
      'error.badRequest': 'Invalid request.',
      'error.network': 'Cannot reach the Host.',
      'error.render': 'The Trash page failed to render',
      'error.runtime': 'The Trash is not ready',
      'error.runtimeHint': 'The plugin runtime is not mounted here; restart DSH and open this page again.',
    }

    const CSS = [
      '.dtr-page{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;padding:calc(28px + var(--dsh-frame-top-clearance,0px)) 0 0;color:var(--dsw-alias-label-primary)}',
      '.dtr-scroll{flex:1;min-height:0;overflow:auto;padding:0 max(max(16px,min(4vw,48px)),50% - 480px) 40px}',
      '.dtr-head{display:flex;align-items:flex-start;gap:12px;margin:0 0 4px}',
      '.dtr-head-icon{display:inline-flex;flex:none;align-items:center;justify-content:center;width:34px;height:34px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dtr-head-text{flex:1;min-width:0}',
      '.dtr-title{margin:0;font-size:20px;line-height:28px;font-weight:600}',
      '.dtr-subtitle{margin:2px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dtr-storage{margin:6px 0 0;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.dtr-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:18px 0 10px}',
      '.dtr-search{position:relative;flex:1 1 220px;min-width:160px}',
      '.dtr-search input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.dtr-search input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dtr-search input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
      '.dtr-summary{margin:0 0 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.dtr-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);overflow:hidden}',
      '.dtr-row{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:transparent}',
      '.dtr-row:first-child{border-top:none}',
      '.dtr-row:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dtr-row[data-live="true"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 7%,transparent)}',
      '.dtr-check{display:flex;flex:none;align-items:center;justify-content:center;width:18px;height:22px}',
      '.dtr-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.dtr-check input:disabled{cursor:default}',
      '.dtr-row-body{flex:1;min-width:0}',
      '.dtr-row-title{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:13px;line-height:20px;font-weight:500;overflow-wrap:anywhere}',
      '.dtr-row-title-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.dtr-row-meta{margin-top:2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.dtr-pill{flex:none;padding:0 6px;border-radius:999px;font-size:10px;line-height:16px;font-weight:500;border:1px solid transparent}',
      '.dtr-pill-live{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.dtr-pill-archived{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 14%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.dtr-pill-seeded{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}',
      '.dtr-row-actions{display:flex;flex:none;align-items:center;gap:4px;padding-top:1px}',
      '.dtr-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:28px;cursor:pointer;white-space:nowrap}',
      '.dtr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dtr-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px}',
      '.dtr-btn:disabled{opacity:.45;cursor:default}',
      '.dtr-btn-quiet{height:26px;padding:0 8px;border-color:transparent;font-size:11px;line-height:24px;color:var(--dsw-alias-label-secondary)}',
      '.dtr-btn-quiet:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dtr-btn-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}',
      '.dtr-btn-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);filter:brightness(1.08)}',
      '.dtr-btn-danger-quiet{color:var(--dsw-alias-state-error-primary)}',
      '.dtr-btn-danger-quiet:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dtr-bulk{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.dtr-bulk-spacer{flex:1}',
      '.dtr-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:64px 16px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg)}',
      '.dtr-empty-icon{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 10%,transparent);color:var(--dsw-alias-label-secondary)}',
      '.dtr-empty-title{margin:0;font-size:14px;line-height:22px;font-weight:600}',
      '.dtr-empty-desc{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);max-width:420px}',
      '.dtr-notice{display:flex;align-items:flex-start;gap:10px;margin:0 0 12px;padding:8px 10px;border-radius:var(--dsw-radius-md);font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.dtr-notice-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary)) 12%,transparent);color:var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary))}',
      '.dtr-notice-err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.dtr-notice-text{flex:1;min-width:0}',
      '.dtr-notice-close{flex:none;height:20px;padding:0 6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer;opacity:.8}',
      '.dtr-notice-close:hover{opacity:1}',
      '.dtr-icon-button{display:inline-flex;flex:none;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dtr-icon-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dtr-icon-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}',
      '.dtr-row-delete:hover{color:var(--dsw-alias-state-error-primary)}',
      '.dtr-menu-item{display:flex;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:32px;padding:0 8px;border:none;border-top:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:start;cursor:pointer}',
      '.dtr-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dtr-menu-item:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:-2px}',
      '.dtr-menu-item-icon{display:inline-flex;flex:none;color:var(--dsw-alias-label-secondary)}',
      '.dtr-menu-item:hover .dtr-menu-item-icon{color:var(--dsw-alias-state-error-primary)}',
      '.dtr-panel-row{display:flex;align-items:center;justify-content:center;color:inherit}',
      '.dtr-backdrop{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}',
      '.dtr-dialog{box-sizing:border-box;width:min(520px,100%);max-height:calc(100vh - 48px);overflow:auto;padding:18px 20px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 16px 40px rgba(0,0,0,.28)}',
      '.dtr-dialog-head{display:flex;align-items:flex-start;gap:12px}',
      '.dtr-dialog-title{margin:0;flex:1;min-width:0;font-size:16px;line-height:24px;font-weight:600}',
      '.dtr-dialog-desc{margin:10px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.dtr-dialog-list{margin:8px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 8%,transparent);font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);max-height:140px;overflow:auto}',
      '.dtr-dialog-list div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dtr-dialog-notice{margin:10px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary);overflow-wrap:anywhere}',
      '.dtr-dialog-error{margin:10px 0 0;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      '.dtr-dialog-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}',
    ].join('')

    /** Tiny subscribable snapshot store. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          if (next === value) return
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /** Resolve one of this plugin's Host routes against the page base. */
    function routeUrl(path) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' && document.baseURI !== ''
        ? document.baseURI
        : 'http://dsh.internal/'
      return new URL(path.replace(/^\/+/, ''), base).href
    }

    /** Trash outline icon, matching the host's line-icon weight. */
    function TrashIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
        h('path', { d: 'M2.75 4.25h10.5' }),
        h('path', { d: 'M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25' }),
        h('path', { d: 'M4 4.25l.68 8.16a1.5 1.5 0 0 0 1.49 1.34h3.66a1.5 1.5 0 0 0 1.49-1.34L12 4.25' }),
        h('path', { d: 'M6.75 6.75v4M9.25 6.75v4' }),
      )
    }

    /** Broom outline icon for "clear the conversation content". */
    function BroomIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
        h('path', { d: 'M9.5 2.5l3 3' }),
        h('path', { d: 'M11 4l-5.2 5.2' }),
        h('path', { d: 'M5.8 9.2l1.4 1.4-1.6 3.2a.7.7 0 0 1-1.2.1L2.4 11a.7.7 0 0 1 .1-1.2z' }),
        h('path', { d: 'M4.6 11.2l1.6-.6M6.1 12.4l.9-1.6' }),
      )
    }

    function RefreshIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false',
      },
        h('path', { d: 'M13 8a5 5 0 1 1-1.6-3.7' }),
        h('path', { d: 'M13 2.6V5.2h-2.6' }),
      )
    }

    function CloseIcon({ size = 14 }) {
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        'aria-hidden': true, focusable: 'false',
      },
        h('path', { d: 'M4 4l8 8M12 4l-8 8' }),
      )
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 KB'
      if (value < 1024) return `${String(Math.round(value))} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
      return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function formatTime(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value <= 0) return ''
      try {
        return new Date(value).toLocaleString()
      } catch {
        return ''
      }
    }

    function mapErrorKey(code) {
      if (code === 'session/live') return 'error.live'
      if (code === 'session/busy') return 'error.busy'
      if (code === 'session/unknown') return 'error.unknown'
      if (code === 'session/children') return 'error.children'
      if (code === 'session/children-live') return 'error.childrenLive'
      if (code === 'session/seeded') return 'error.seeded'
      if (code === 'storage-unresolved') return 'error.storage'
      if (code === 'unsupported-compression' || code === 'log-too-large' || code === 'log-corrupt') return 'error.unsupported'
      if (code === 'forbidden') return 'error.forbidden'
      if (code === 'method-error') return 'error.method'
      if (code === 'bad-request') return 'error.badRequest'
      if (code === 'network') return 'error.network'
      return undefined
    }

    /** Describe one row's target title, falling back to the id. */
    function rowTitle(row, t) {
      return row.title !== '' ? row.title : `${t('row.untitled')} · ${row.sessionId}`
    }

    /** One stored Session row. */
    function TrashRow({ row, t, selected, onToggle, onClear, onDelete, busy }) {
      const title = rowTitle(row, t)
      const clearDisabled = busy || row.seeded
      const deleteDisabled = busy
      const clearHint = row.live
        ? t('row.liveClearHint')
        : row.seeded ? t('row.seededHint') : t('row.clearTitle')
      const deleteHint = row.live ? t('row.liveDeleteHint') : t('row.deleteTitle')
      const meta = [
        formatBytes(row.sizeBytes),
        typeof row.eventCount === 'number' ? t('row.events', { count: row.eventCount }) : '',
        formatTime(row.updatedAt),
        row.cwd,
      ].filter((part) => part !== '' && part !== undefined).join(' · ')
      return h('div', { className: 'dtr-row', 'data-live': String(row.live === true) },
        h('label', { className: 'dtr-check' },
          h('input', {
            type: 'checkbox',
            checked: selected,
            disabled: row.live,
            'aria-label': t('row.checkbox', { title }),
            onChange: () => onToggle(row.sessionId),
          }),
        ),
        h('div', { className: 'dtr-row-body' },
          h('div', { className: 'dtr-row-title' },
            h('span', { className: 'dtr-row-title-text', title }, title),
            row.live && h('span', { className: 'dtr-pill dtr-pill-live' }, t('row.live')),
            row.archived && h('span', { className: 'dtr-pill dtr-pill-archived' }, t('row.archived')),
            row.seeded && h('span', { className: 'dtr-pill dtr-pill-seeded' }, t('row.seeded')),
          ),
          h('div', { className: 'dtr-row-meta' }, meta),
        ),
        h('div', { className: 'dtr-row-actions' },
          h('button', {
            type: 'button',
            className: 'dtr-btn dtr-btn-quiet',
            title: clearHint,
            disabled: clearDisabled,
            onClick: () => onClear(row.sessionId),
          }, h(BroomIcon), h('span', null, t('row.clear'))),
          h('button', {
            type: 'button',
            className: 'dtr-btn dtr-btn-quiet dtr-btn-danger-quiet',
            title: deleteHint,
            disabled: deleteDisabled,
            onClick: () => onDelete(row.sessionId),
          }, h(TrashIcon), h('span', null, t('row.delete'))),
        ),
      )
    }

    /** The confirmation dialog for one pending batch. */
    function TrashConfirm({ pending, rows, t, busy, failure, onCancel, onConfirm, onCascade, cascadeCount }) {
      const ids = pending.ids
      const titles = ids.map((id) => {
        const row = rows.find((candidate) => candidate.sessionId === id)
        return row === undefined ? id : rowTitle(row, t)
      })
      const preview = titles.slice(0, 6)
      const rest = Math.max(0, titles.length - preview.length)
      const isDelete = pending.kind === 'delete'
      const liveCount = ids.filter((id) => {
        const row = rows.find((candidate) => candidate.sessionId === id)
        return row !== undefined && row.live
      }).length
      useEffect(() => {
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          if (!busy) onCancel()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => { window.removeEventListener('keydown', onKeyDown, true) }
      }, [busy, onCancel])
      return h('div', {
        className: 'dtr-backdrop',
        onMouseDown: (event) => {
          if (event.target === event.currentTarget && !busy) onCancel()
        },
      },
        h('div', {
          className: 'dtr-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-labelledby': 'dtr-confirm-title',
        },
          h('div', { className: 'dtr-dialog-head' },
            h('h2', { id: 'dtr-confirm-title', className: 'dtr-dialog-title' },
              t(isDelete ? 'confirm.delete.title' : 'confirm.clear.title')),
            h('button', {
              type: 'button',
              className: 'dtr-icon-button',
              title: t('confirm.cancel'),
              'aria-label': t('confirm.cancel'),
              disabled: busy,
              onClick: onCancel,
            }, h(CloseIcon)),
          ),
          h('p', { className: 'dtr-dialog-desc' },
            t(isDelete ? 'confirm.delete.desc' : 'confirm.clear.desc', { count: ids.length })),
          h('div', { className: 'dtr-dialog-list' },
            h('div', null, t('confirm.list')),
            ...preview.map((title, index) => h('div', { key: `t${String(index)}` }, `· ${title}`)),
            rest > 0 && h('div', null, t('confirm.more', { count: rest })),
          ),
          cascadeCount > 0 && h('p', { className: 'dtr-dialog-notice', role: 'status' },
            t('confirm.cascadeNotice', { count: cascadeCount })),
          liveCount > 0 && h('p', { className: 'dtr-dialog-notice', role: 'status' },
            t('confirm.liveNotice', { count: liveCount })),
          failure !== null && h('p', { className: 'dtr-dialog-error', role: 'alert' }, failure),
          h('div', { className: 'dtr-dialog-footer' },
            h('button', { type: 'button', className: 'dtr-btn', disabled: busy, onClick: onCancel }, t('confirm.cancel')),
            cascadeCount > 0 && h('button', {
              type: 'button',
              className: 'dtr-btn',
              disabled: busy,
              onClick: onCascade,
            }, t('confirm.cascade', { count: cascadeCount })),
            h('button', {
              type: 'button',
              className: 'dtr-btn dtr-btn-danger',
              disabled: busy,
              onClick: onConfirm,
            }, busy
              ? t('confirm.busy')
              : t(isDelete ? 'confirm.delete' : 'confirm.clear')),
          ),
        ),
      )
    }

    /** Fallback translator when the slot does not hand one down. */
    const identityT = (key) => key

    /** Subscribe one component to the trash store without newer React helpers. */
    function useTrashState(store) {
      const [state, setState] = useState(() => store.getSnapshot())
      useEffect(() => store.subscribe(() => setState(store.getSnapshot())), [store])
      return state
    }

    /**
     * Keep a render failure readable instead of leaving the panel blank: a
     * throwing slot entry is otherwise replaced by nothing at all.
     */
    class TrashBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('[trash] page crashed:', error)
      }

      render() {
        const t = typeof this.props.t === 'function' ? this.props.t : identityT
        if (this.state.error !== null) {
          const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error)
          return h('div', { className: 'dtr-page' },
            h('div', { className: 'dtr-scroll' },
              h('div', { className: 'dtr-empty' },
                h('p', { className: 'dtr-empty-title' }, t('error.render')),
                h('p', { className: 'dtr-empty-desc' }, message),
              ),
            ),
          )
        }
        return this.props.children
      }
    }

    /** The Trash page — the `main` panel keyed `trash`. */
    function TrashPage(props) {
      const t = typeof props.t === 'function' ? props.t : identityT
      const store = props.hooks !== null && typeof props.hooks === 'object' ? props.hooks.trash : undefined
      const api = props.api
      if (store === undefined || api === undefined) {
        return h('div', { className: 'dtr-page' },
          h('div', { className: 'dtr-scroll' },
            h('div', { className: 'dtr-empty' },
              h('p', { className: 'dtr-empty-title' }, t('error.runtime')),
              h('p', { className: 'dtr-empty-desc' }, t('error.runtimeHint')),
            ),
          ),
        )
      }
      return h(TrashPageBody, { t, store, api })
    }

    /** The real page, rendered only once its runtime is known to exist. */
    function TrashPageBody({ t, store, api }) {
      const state = useTrashState(store)

      useEffect(() => {
        void api.load()
      }, [])

      const rows = state.sessions
      const filter = state.filter.trim().toLowerCase()
      const visible = useMemo(() => {
        if (filter === '') return rows
        return rows.filter((row) => (
          row.title.toLowerCase().includes(filter)
          || row.cwd.toLowerCase().includes(filter)
          || row.sessionId.toLowerCase().includes(filter)
        ))
      }, [rows, filter])

      const selectable = visible.filter((row) => !row.live)
      const selectedIds = Object.keys(state.selected).filter((id) => state.selected[id] === true)
      const selectedRows = rows.filter((row) => state.selected[row.sessionId] === true)
      const selectedClearable = selectedRows.filter((row) => !row.live && !row.seeded)
      const allSelectableChosen = selectable.length > 0 && selectable.every((row) => state.selected[row.sessionId] === true)
      const busy = state.busy

      const cascadeCount = state.cascadeCount ?? 0

      return h('div', { className: 'dtr-page' },
        h('div', { className: 'dtr-scroll' },
          h('div', { className: 'dtr-head' },
            h('span', { className: 'dtr-head-icon' }, h(TrashIcon, { size: 18 })),
            h('div', { className: 'dtr-head-text' },
              h('h1', { className: 'dtr-title' }, t('page.title')),
              h('p', { className: 'dtr-subtitle' }, t('page.subtitle')),
              state.rootDisplay !== '' && h('p', { className: 'dtr-storage' }, t('page.storage', { path: state.rootDisplay })),
            ),
            h('button', {
              type: 'button',
              className: 'dtr-btn',
              disabled: state.loading || busy,
              onClick: () => { void api.load() },
            }, h(RefreshIcon), h('span', null, t('page.refresh'))),
          ),

          state.notice !== null && h('div', {
            className: `dtr-notice dtr-notice-${state.notice.kind === 'ok' ? 'ok' : 'err'}`,
            role: state.notice.kind === 'ok' ? 'status' : 'alert',
          },
            h('span', { className: 'dtr-notice-text' }, state.notice.text),
            h('button', {
              type: 'button',
              className: 'dtr-notice-close',
              onClick: () => api.dismissNotice(),
            }, t('notice.close')),
          ),

          h('div', { className: 'dtr-toolbar' },
            h('div', { className: 'dtr-search' },
              h('input', {
                type: 'search',
                value: state.filter,
                placeholder: t('page.search'),
                'aria-label': t('page.search'),
                onChange: (event) => api.setFilter(event.target.value),
              }),
            ),
            h('button', {
              type: 'button',
              className: 'dtr-btn',
              disabled: busy || selectable.length === 0,
              onClick: () => api.toggleAll(!allSelectableChosen),
            }, allSelectableChosen ? t('action.selectNone') : t('action.selectAll')),
            h('button', {
              type: 'button',
              className: 'dtr-btn',
              disabled: busy || selectedClearable.length === 0,
              onClick: () => api.request('clear', selectedClearable.map((row) => row.sessionId)),
            }, h(BroomIcon), h('span', null, t('action.clearSelected'))),
            h('button', {
              type: 'button',
              className: 'dtr-btn dtr-btn-danger',
              disabled: busy || selectedRows.filter((row) => !row.live).length === 0,
              onClick: () => api.request('delete', selectedRows.filter((row) => !row.live).map((row) => row.sessionId)),
            }, h(TrashIcon), h('span', null, t('action.deleteSelected'))),
          ),

          h('p', { className: 'dtr-summary' },
            t('summary', {
              count: state.totals.count,
              size: formatBytes(state.totals.bytes),
              live: state.totals.live,
              archived: state.totals.archived,
            }),
            selectedIds.length > 0 ? ` · ${t('selection.count', { count: selectedIds.length })}` : '',
          ),

          state.loading && !state.loaded
            ? h('div', { className: 'dtr-empty' }, h('p', { className: 'dtr-empty-desc' }, t('loading')))
            : state.error !== null
              ? h('div', { className: 'dtr-empty' },
                h('p', { className: 'dtr-empty-title' }, t('error.title')),
                h('p', { className: 'dtr-empty-desc' }, state.error),
                h('button', { type: 'button', className: 'dtr-btn', onClick: () => { void api.load() } }, t('page.refresh')),
              )
              : visible.length === 0
                ? h('div', { className: 'dtr-empty' },
                  h('span', { className: 'dtr-empty-icon' }, h(TrashIcon, { size: 24 })),
                  h('p', { className: 'dtr-empty-title' }, filter === '' ? t('empty.title') : t('empty.filter')),
                  filter === '' ? h('p', { className: 'dtr-empty-desc' }, t('empty.desc')) : null,
                )
                : h('div', { className: 'dtr-list' },
                  ...visible.map((row) => h(TrashRow, {
                    key: row.sessionId,
                    row,
                    t,
                    busy,
                    selected: state.selected[row.sessionId] === true,
                    onToggle: (id) => api.toggle(id),
                    onClear: (id) => api.request('clear', [id]),
                    onDelete: (id) => api.request('delete', [id]),
                  })),
                ),

          state.loaded && rows.length > 0 && h('div', { className: 'dtr-bulk' },
            h('span', { className: 'dtr-summary', style: { margin: 0 } },
              t('selection.count', { count: selectedIds.length })),
            h('span', { className: 'dtr-bulk-spacer' }),
            h('button', {
              type: 'button',
              className: 'dtr-btn',
              disabled: busy || rows.filter((row) => !row.live && !row.seeded).length === 0,
              onClick: () => api.request('clear', rows.filter((row) => !row.live && !row.seeded).map((row) => row.sessionId)),
            }, h(BroomIcon), h('span', null, t('action.clearAll'))),
            h('button', {
              type: 'button',
              className: 'dtr-btn dtr-btn-danger',
              disabled: busy || rows.filter((row) => !row.live).length === 0,
              onClick: () => api.request('delete', rows.filter((row) => !row.live).map((row) => row.sessionId)),
            }, h(TrashIcon), h('span', null, t('action.deleteAll'))),
          ),
        ),

        state.pending !== null && h(TrashConfirm, {
          pending: state.pending,
          rows,
          t,
          busy,
          failure: state.pendingFailure,
          cascadeCount,
          onCancel: () => api.dismiss(),
          onConfirm: () => { void api.confirm() },
          onCascade: () => api.cascadeRetry(),
        }),
      )
    }

    /** Sidebar global-panel row icon. */
    function SidebarTrashRow(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h('span', { className: 'dtr-panel-row' }, h(TrashIcon, { size }))
    }

    /** Hover control at the end of one Session row. */
    function SessionTrashRowButton(props) {
      const { sessionId, displayTitle, api, t } = props
      return h('button', {
        type: 'button',
        className: 'dtr-icon-button dtr-row-delete',
        title: t('row.delete'),
        'aria-label': t('row.delete'),
        onClick: (event) => {
          event.preventDefault()
          event.stopPropagation()
          api.openTrash({ preselect: sessionId, displayTitle })
        },
      }, h(TrashIcon))
    }

    /** The same entrance as a row in the Session's "..." menu. */
    function SessionTrashMenuItem(props) {
      const { sessionId, displayTitle, api, t, useMenuOpenState } = props
      const [, setMenuOpen] = useMenuOpenState()
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dtr-menu-item',
        onClick: () => {
          setMenuOpen(false)
          api.openTrash({ preselect: sessionId, displayTitle })
        },
      },
        h('span', { className: 'dtr-menu-item-icon' }, h(TrashIcon)),
        h('span', null, t('menu.open')),
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const store = createStore({
        sessions: [],
        totals: { count: 0, bytes: 0, live: 0, archived: 0 },
        rootDisplay: '',
        canClear: true,
        loading: false,
        loaded: false,
        error: null,
        filter: '',
        selected: {},
        pending: null,
        pendingFailure: null,
        cascadeCount: 0,
        busy: false,
        notice: null,
      })
      const update = (patch) => { store.set({ ...store.getSnapshot(), ...patch }) }
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'trash: dictionaries')
      const t = ctx.locale.bind(NS)
      const clientSessions = () => ctx.get('sessions')

      /** Read one JSON response from a plugin route, mapping failures to codes. */
      const requestJson = async (path, init) => {
        let response
        try {
          response = await fetch(routeUrl(path), init)
        } catch (cause) {
          const error = new Error(cause instanceof Error ? cause.message : String(cause))
          error.code = 'network'
          throw error
        }
        let payload
        try {
          payload = await response.json()
        } catch {
          payload = undefined
        }
        if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
          const reported = payload !== null && typeof payload === 'object' && payload.error !== null && typeof payload.error === 'object'
            ? payload.error
            : undefined
          const error = new Error(
            reported !== undefined && typeof reported.message === 'string' ? reported.message : `HTTP ${response.status}`,
          )
          error.code = reported !== undefined ? reported.code : undefined
          error.details = reported !== undefined ? reported.details : undefined
          throw error
        }
        return payload.value
      }

      const describeFailure = (failure) => {
        const key = mapErrorKey(failure?.code)
        return key === undefined
          ? t('notice.failed', { message: typeof failure?.message === 'string' ? failure.message : String(failure?.code ?? 'unknown') })
          : t(key)
      }

      const load = async () => {
        const snapshot = store.getSnapshot()
        if (snapshot.loading) return
        update({ loading: true, error: null })
        try {
          const value = await requestJson('trash/api/list', { method: 'GET', cache: 'no-store' })
          const sessions = Array.isArray(value?.sessions) ? value.sessions : []
          const keep = {}
          for (const row of sessions) {
            if (store.getSnapshot().selected[row.sessionId] === true && row.live !== true) keep[row.sessionId] = true
          }
          update({
            sessions,
            totals: value?.totals ?? { count: sessions.length, bytes: 0, live: 0, archived: 0 },
            rootDisplay: typeof value?.rootDisplay === 'string' ? value.rootDisplay : '',
            canClear: value?.canClear !== false,
            loading: false,
            loaded: true,
            error: null,
            selected: keep,
          })
        } catch (error) {
          update({
            loading: false,
            loaded: true,
            error: describeFailure(error),
          })
        }
      }

      const openTrash = (options = {}) => {
        const preselect = typeof options.preselect === 'string' ? options.preselect : undefined
        if (preselect !== undefined) {
          update({ selected: { ...store.getSnapshot().selected, [preselect]: true } })
        }
        ctx.get('layout')?.selectPanel(PANEL_ID)
        void load()
      }

      const mutate = async (kind, ids, cascade) => {
        const path = kind === 'delete' ? 'trash/api/delete' : 'trash/api/clear'
        const body = kind === 'delete' ? { sessionIds: ids, cascade: cascade === true } : { sessionIds: ids }
        return requestJson(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      }

      /**
       * Move the UI off a Session that is about to be deleted while it is still
       * the one on screen: the Host stops its Agent, and the Conversation view
       * must not keep rendering a log that is going away.
       */
      const switchAwayFrom = (ids) => {
        const sessions = clientSessions()
        const opened = ids.some((id) => {
          try {
            return typeof sessions?.scope === 'function' && sessions.scope(id) !== undefined
          } catch {
            return false
          }
        })
        if (!opened) return
        const workspaceNavigation = ctx.get('uiWorkspace')
        try {
          workspaceNavigation?.startSession?.()
        } catch (cause) {
          console.warn('[trash] switching to a new session failed:', cause)
        }
      }

      const confirm = async () => {
        const snapshot = store.getSnapshot()
        const pending = snapshot.pending
        if (pending === null || snapshot.busy) return
        if (pending.ids.length > 0) switchAwayFrom(pending.ids)
        update({ busy: true, pendingFailure: null })
        try {
          const value = await mutate(pending.kind, pending.ids, pending.cascade)
          const results = Array.isArray(value?.results) ? value.results : []
          const done = results.filter((entry) => entry.ok === true).map((entry) => entry.sessionId)
          const failed = results.filter((entry) => entry.ok !== true)
          const forced = results
            .filter((entry) => entry.ok === true && Array.isArray(entry.value?.forced) && entry.value.forced.length > 0)
            .reduce((sum, entry) => sum + entry.value.forced.length, 0)
          const cascadeFailures = failed.filter((entry) => entry?.error?.code === 'session/children')
          const cascadeCount = cascadeFailures.reduce((sum, entry) => {
            const count = entry?.error?.details?.count
            return sum + (typeof count === 'number' ? count : 1)
          }, 0)

          if (done.length > 0) {
            const sessions = clientSessions()
            if (pending.kind === 'delete') {
              for (const id of done) {
                try {
                  sessions?.handleSessionRemoved?.(id)
                } catch (cause) {
                  console.warn('[trash] local row removal failed:', cause)
                }
              }
            }
            try {
              void sessions?.refresh?.()?.catch?.((cause) => {
                console.warn('[trash] session list refresh failed:', cause)
              })
            } catch (cause) {
              console.warn('[trash] session list refresh failed:', cause)
            }
          }

          if (failed.length === 0) {
            const base = pending.kind === 'delete'
              ? t('notice.deleted', { count: done.length })
              : t('notice.cleared', { count: done.length })
            update({
              busy: false,
              pending: null,
              pendingFailure: null,
              cascadeCount: 0,
              selected: {},
              notice: {
                kind: 'ok',
                text: forced > 0 ? `${base} ${t('notice.forced', { count: forced })}` : base,
              },
            })
            await load()
            return
          }

          const first = failed[0]?.error
          const detail = describeFailure(first)
          if (cascadeFailures.length === failed.length && pending.kind === 'delete' && pending.cascade !== true) {
            update({
              busy: false,
              cascadeCount,
              pendingFailure: `${t('notice.partial', { ok: done.length, failed: failed.length })} ${detail}`,
            })
            await load()
            return
          }

          update({
            busy: false,
            pending: null,
            pendingFailure: null,
            cascadeCount: 0,
            selected: {},
            notice: {
              kind: 'err',
              text: `${t('notice.partial', { ok: done.length, failed: failed.length })} ${detail}`,
            },
          })
          await load()
        } catch (error) {
          update({ busy: false, pendingFailure: describeFailure(error) })
        }
      }

      const api = {
        load,
        openTrash,
        setFilter: (value) => update({ filter: typeof value === 'string' ? value : '' }),
        dismissNotice: () => update({ notice: null }),
        toggle: (sessionId) => {
          const selected = { ...store.getSnapshot().selected }
          if (selected[sessionId] === true) delete selected[sessionId]
          else selected[sessionId] = true
          update({ selected })
        },
        toggleAll: (flag) => {
          const snapshot = store.getSnapshot()
          const filter = snapshot.filter.trim().toLowerCase()
          const selected = {}
          if (flag) {
            for (const row of snapshot.sessions) {
              if (row.live) continue
              if (filter !== '' && !(row.title.toLowerCase().includes(filter)
                || row.cwd.toLowerCase().includes(filter)
                || row.sessionId.toLowerCase().includes(filter))) continue
              selected[row.sessionId] = true
            }
          }
          update({ selected })
        },
        request: (kind, ids) => {
          const list = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []
          if (list.length === 0) return
          update({ pending: { kind, ids: list, cascade: false }, pendingFailure: null, cascadeCount: 0 })
        },
        dismiss: () => {
          if (store.getSnapshot().busy) return
          update({ pending: null, pendingFailure: null, cascadeCount: 0 })
        },
        cascadeRetry: () => {
          const snapshot = store.getSnapshot()
          if (snapshot.pending === null || snapshot.busy) return
          update({ pending: { ...snapshot.pending, cascade: true }, pendingFailure: null })
        },
        confirm,
      }

      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const pluginCss = 'dsh-trash/client.css'
        for (const stale of document.querySelectorAll('style[data-plugin-css]')) {
          if (stale.dataset.pluginCss === pluginCss) stale.remove()
        }
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-trash'
        tag.dataset.pluginCss = pluginCss
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => { tag.remove() }
      }, 'trash: styles')

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({ hooks: { trash: store }, api, t }),
      }, (ownerProps = {}) => {
        const translate = typeof ownerProps.t === 'function' ? ownerProps.t : t
        const runtimeHooks = ownerProps.hooks !== undefined && ownerProps.hooks !== null
          ? ownerProps.hooks
          : { trash: store }
        const runtimeApi = ownerProps.api !== undefined ? ownerProps.api : api
        return h(TrashBoundary, { t: translate },
          h(TrashPage, { ...ownerProps, hooks: runtimeHooks, api: runtimeApi, t: translate }))
      }))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 2,
        label: () => t('nav'),
        locale: NS,
      }, SidebarTrashRow))

      ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.row.action',
        id: 'trash',
        order: 320,
        locale: NS,
        inject: () => ({ api, t }),
      }, SessionTrashRowButton))

      ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.menu.item',
        id: 'trash',
        order: 480,
        locale: NS,
        inject: () => ({ api, t }),
      }, SessionTrashMenuItem))
    }

    return { inject, apply }
  },
})
