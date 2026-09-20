# 方案 A 实施方案:桌面版侧栏用量面板(对齐 Kimi Code Monitor)

目标:单文件零依赖注入脚本,在桌面版侧栏提供与该 Chrome 插件一致的用量监控体验。
完全自包含,不依赖原型 B 服务。

## 数据源(均已实测可用)

| 通道 | 地址 | 用途 |
|---|---|---|
| REST 轮询 | `{origin}/api/v1/oauth/usage` (60s) | 5h/7d 额度、resetAt、加油包余额 |
| WebSocket | `ws://{host}/api/v1/ws?client_id=kimi-usage-widget` | 实时 token、速率、耗时、子代理状态 |
| REST 按需 | `{origin}/api/v1/sessions` / `/{sid}/status` | 会话列表(订阅用)、上下文占用 |

origin 解析三级回退:`location.search` 的 `kimi_origin` → `sessionStorage['kimi-desktop-server-origin']`(与桌面应用本体同 key)→ `localStorage['kum.origin']`。

## WS 协议细节(已从 kap-server 源码确认)

- 握手:收到 `server_hello` 后发 `{"type":"client_hello","id":"h1","payload":{"client_id":"...","subscriptions":[...]}}`(**字段必须嵌套在 payload 里**,这是上次实测踩过的坑)
- 服务端回 `ack`,`payload.accepted_subscriptions` 为空且目标在 `resync_required` = 会话不可订阅(非 live),稍后重试
- 心跳:服务端每 10s 发 `ping`,必须回 `{"type":"pong","payload":{"nonce"}}`,连续 2 次不应答会被掐断
- 订阅策略:连接后先 `GET /api/v1/sessions` 拉全部 live 会话批量订阅;全局事件 `session.meta.updated` 里出现新会话时补订阅;URL 路由变化时把"当前会话"标记为焦点会话
- 断线:指数退避重连(1s→30s 封顶),重连后带 `cursors: {sid: {seq}}` 续传去重
- 事件信封:`{type, seq, session_id, payload:{...}}`

## 指标计算

| 指标 | 算法 |
|---|---|
| 当前轮输入/输出/缓存 | `agent.status.updated` 的 `payload.usage.currentTurn` |
| 会话累计 | 同上事件的 `usage.total` |
| token 速率 | 滑动窗口:保存最近 10s 内 `(ts, total.output)` 采样,`Δoutput/Δt`,显示 tok/s;空闲 5s 归零 |
| 缓存命中率 | `inputCacheRead/(inputOther+inputCacheRead+inputCacheCreation)`,total 口径 |
| 上轮耗时 | `turn.ended` 的 `payload.durationMs` |
| 子代理 | `subagent.started/stopped` 维护存活列表,显示个数+最近名称 |
| 上下文占用 | `GET /sessions/{sid}/status` 的 `context_tokens/max_context_tokens`(60s 随额度一起轮询) |
| 匀速参照线 | `已过去时长/窗口总时长` vs `usedRatio`,在额度条上画一条竖刻线 |

## 历史统计(自积累)

- 存储:localStorage `kum.stats.v1` = `{"2026-09-18": {input, cacheRead, cacheCreation, output, turns}}`
- 采集:对每个订阅会话的 `agent.status.updated`,用 `total` 与上一次快照做差分,按本地日期落入当日桶(避免多会话/重连重复计数)
- 展示:近 7 天迷你柱状图(侧栏宽度有限,7 天柱+悬停显示明细;30 天数字汇总)
- 已知限制:补丁安装前的历史为空;仅统计桌面版运行期间的用量

## 告警

- 阈值:任一额度窗口 ≥80% 提醒一次,≥95% 警告一次;`resetAt` 过后重置告警状态
- 通道:`Notification`(首次使用时请求权限);localStorage `kum.alerted` 持久化已报状态防重复

## UI 结构

```
┌─ Kimi 用量 ─────────────── [–] ← 点击折叠(只留标题栏)
│  [展开区,模块可长按拖拽排序]
│  5h额度  ▓▓▓░░|░░  26%   重置 05:24 (剩 2h41m)   ← | 为匀速参照线
│  本周    ▓▓▓▓▓|░  82%   重置 周五 02:24
│  输入 15.1K   输出 5.8K   缓存命中 98.7%   42 tok/s
│  上轮 1m23s · 上下文 14.4% · 子代理 2
│  近7天 ▁▃▂▅▇▃▅  今日 5.6M
├─ Mini 区(一行一个,小数字)
│  5h 26% · 周 82% · 42 tok/s
└─ 隐藏区(仅标题,点击展开)
```

- 模块:id 固定,布局存 `kum.layout`(`[{id, zone:'main'|'mini'|'hidden'}]`);拖拽用手写 mousedown 长按 300ms 触发(不依赖 HTML5 DnD,Electron 里更稳),拖动时显示插入位置指示线,松手落位并持久化
- 挂载:优先插在 `.side-footer` 前(已验证可行),失败退化为左下角浮动卡片
- 主题:跟随 `document.documentElement.dataset.colorScheme` 切换深浅色变量
- 错误可视:任何一环失败(origin 缺失/WS 连不上/接口报错)在面板顶部显示红色一行说明,不再静默

## localStorage 键清单

`kum.origin` `kum.collapsed` `kum.layout` `kum.stats.v1` `kum.alerted` `kum.speedSamples`(会话级,不持久化)

## 与插件的对齐度声明

做到:额度条+参照线+倒计时、实时四指标、上轮耗时、子代理状态、消耗图表(自积累)、拖拽三区、阈值告警。
不做(二期):收藏星标、Rive 宠物、外部账户、分享卡片、AI 自动命名(桌面版服务端自带 `/title/generate`,应用本身已覆盖)。

## 验证计划

1. `node --check` 语法
2. 重打补丁后重启桌面版,信标改为面板内错误行自检(不再依赖外部服务)
3. 用桌面版内置浏览器面板截图确认渲染效果
4. 告警逻辑:临时把阈值改成 1% 验证通知弹出,再改回
5. 统计积累:跑一轮后检查 `kum.stats.v1` 当日桶有数

## 交付物

- `desktop-patch/kimi-usage-widget.js` 重写(约 700 行)
- `patch-desktop.py` 不变(幂等重打即升级)
- README 更新
