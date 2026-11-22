# dsh-trash

**A Trash panel for DeepSeek Harness.** DeepSeek Harness can archive a Session but never delete one — the persistence seam has no delete API at all. This bundle adds the missing piece: a Trash page that lists every stored Session on this machine and lets you either **delete the session file** or **clear a conversation's content** while keeping the session itself.

> DeepSeek Harness 原生只能归档会话，持久化层没有删除接口。这个插件补上一个**垃圾桶**：列出本机所有已存储会话，既能删除会话文件，也能清空对话内容而保留会话条目。

---

## 它解决什么

- 会话越攒越多，侧栏里全是旧对话，只能归档不能清理；
- 会话文件里是完整的对话记录，想彻底抹掉只能手动去 `~/.dsh/sessions` 里翻目录；
- 想"清空这段对话但保留这个会话"没有任何入口。

## 三个入口，一个页面

| 入口 | 位置 |
|---|---|
| 侧栏全局面板行（垃圾桶图标） | 与「插件」「插件市场」「自动化任务」并列 |
| 会话行悬停按钮（垃圾桶） | 鼠标移到侧栏任一会话行，行尾出现 |
| 会话「…」菜单 → 移入垃圾桶 | 打开垃圾桶并预选该会话 |

页面能力：列出全部会话（标题 / 大小 / 更新时间 / 工作目录 / 状态标签）、搜索筛选、勾选批量、全选、逐项结果反馈。

## 两个操作

### 删除文件

永久移除该会话在磁盘上的记录：

1. 把 `<会话目录>/session[.vN].jsonl[.zstd]` 改名为 `.trash-deleted-<时间戳>` —— 这一步是**原子的提交点**，没有规范日志的会话对 list/stat/open 立刻不可见；
2. 尽力删除整个会话目录与空掉的父目录；
3. 清掉 `session_projcache` 存储域里该会话的投影缓存行；
4. 从 workspace 记账里摘下该会话（工作区 `sessionIds`、归档列表、置顶列表）。

### 清空内容

保留会话条目，丢掉全部消息：

1. 只保留日志的 header 记录，用文件**原本的编码**（zstd 或明文）原地重写；
2. 重写后立刻再解码校验；
3. 校验失败则从备份恢复，成功才删除备份。

派生会话（分叉 / 子代理）**拒绝清空**：它的 header 承诺了一段从父会话继承的种子前缀，清空会让这个会话不可再读。删除它则没问题。

## 使用中的会话也能直接删

harness 的 `Agent` 接口只提供 `cancel()` 与 `whenIdle()`，没有 disposer，所以插件无法卸载别人的 Agent。删除一个正在使用的会话时：

1. Host 先 `cancel({ kind: 'user' })` 停掉它当前的工作，并等待静默（最多 1.5 秒）；
2. 界面把当前打开的会话切走，避免对话区继续渲染已经消失的日志；
3. 执行删除 / 清空。

若那个 Agent 之后又写了一次、把日志重新建出来，Host 会把它记为 **tombstone**：每分钟扫描一次、最多一小时内反复清掉被重建的日志，不会留下读不出的坏文件。

## 安全边界

- 路由只接受**本机同源**请求：Host 必须是 loopback，`sec-fetch-site` 不能是 `cross-site`，带了 `Origin` 就必须和 Host 同 authority；
- 会话 id 走严格白名单 `^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$`，每个路径都验证仍在会话根目录内；
- 有派生会话时需显式 `cascade: true`，不会静默连带删除；
- 批量操作**逐项报告**结果，一项被拒不会掩盖其它项；
- 插件不联网，不收集任何数据。

## 安装

### 方式一：本地目录安装（推荐）

把仓库放在任意位置，然后在 DSH 会话里让 agent 安装这个目录：

```
plugin_manager install_bundle, target = <仓库绝对路径>
```

安装结果里 `application: applied` 表示已热加载；`restart-required` 时重启 DSH。装完侧栏底部会出现垃圾桶图标。

### 方式二：放进 profile 手工挂载

不推荐。需要把目录链接进 `$DSH_HOME/profiles/<profile>/node_modules/`，并在该 profile 的 `package.json` 里把包名加进 `dependencies` 与 `dsh.profile.bundles`。

## 卸载

```
plugin_manager remove_bundle, target = dsh-trash
```

插件本身不写任何标记文件；删除的会话不会留在"回收站"里，**没有撤销**。

## Host 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/trash/api/list` | 列出所有已存储会话及元数据 |
| `POST` | `/trash/api/delete` | `{ sessionIds: string[], cascade?: boolean }` |
| `POST` | `/trash/api/clear` | `{ sessionIds: string[] }` |

两个写操作都返回逐项结果：

```json
{
  "ok": true,
  "value": {
    "results": [
      { "sessionId": "session-…", "ok": true, "value": { "deleted": ["…"], "forced": ["…"] } },
      { "sessionId": "session-…", "ok": false, "error": { "code": "session/seeded", "message": "…" } }
    ]
  }
}
```

失败码：`session/unknown`、`session/busy`、`session/seeded`、`session/children`、`storage-unresolved`、`unsupported-compression`、`forbidden`、`bad-request`。

## 文件结构

```
index.js          Host 半：路由、存储操作、workspace 记账、tombstone 清扫
client.js         Client 半：垃圾桶页面、侧栏入口、确认对话框
cordis.patch.yml  bundle patch（插入一行 id: trash）
locale/zh.json    展示元数据（中文）
locale/en.json    展示元数据（英文）
icon.svg          插件图标
test/             三个离线测试
```

## 测试

```bash
npm test
```

- `test/e2e.mjs` —— 复制真实会话日志到临时根，用真实 handler 跑 list → 清空（含 live 会话先 cancel）→ 删除（含 live 直删）→ tombstone 自愈；
- `test/client-smoke.mjs` —— 模块形态、四个 slot 注册、中英字典对齐、样式注入；
- `test/render-smoke.mjs` —— 用 React stub 渲染七种页面状态与三个外部组件，确保首屏不崩。

三个测试都不触碰你的真实会话（只读其中一份作为样本）。

## 已知限制

- **清空内容不适用于派生会话**（fork / subagent 子会话），原因见上；这类会话只能删除。
- 压缩日志的改写依赖 Node 的 `zlib.zstdCompressSync`（Node ≥ 22.15 / 24）。运行时没有该 API 时，界面会提示改用删除文件。
- 会话事件计数据持久化层不提供，因此列表只显示文件大小而非事件条数。
- 副作用只在磁盘上：插件不改会话格式、不写自定义事件类型。

## 许可证

[MIT](LICENSE)
