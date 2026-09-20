# Kimi Code 用量面板 (kimi-usage-widget)

给 **Kimi Code 桌面版**(Windows)侧栏注入一个实时用量监控面板的非官方补丁。

灵感来自浏览器插件 Kimi Code Monitor,但实现方式不同:不依赖浏览器扩展机制,而是直接向桌面版的本地 UI 资源注入一个零依赖的 JS 面板,数据全部来自桌面版**内嵌服务的官方本地接口**,无需额外登录、不碰账号凭据。

## 功能

- **额度条**:5 小时 / 本周(及月度,如账号支持)用量百分比,带匀速参照线;悬停显示重置倒计时;80% / 95% 阈值系统通知告警
- **实时面板**:当前轮输入 / 输出 tokens、缓存命中率、输出速率(tok/s)——通过内嵌服务的 WebSocket 事件流秒级刷新
- **状态行**:上轮耗时 · 上下文占用 · 活跃子代理数
- **近 7 天消耗**:迷你柱状图(自补丁启用起按天积累)
- **可定制**:模块可长按拖拽排序;⚙ 菜单里可将模块收入 Mini 区或隐藏;紧凑 / 宽松两档密度;折叠状态记忆
- **自愈**:桌面版自动更新会覆盖补丁,附带的监听进程检测到覆盖后自动重装补丁

## 快速开始

需要:Windows + Python 3.8+(仅安装脚本用,panel 本体是纯 JS)。

```bash
# 1. 打补丁(自动定位桌面版安装目录, 找不到可用 --target 指定)
python patch-desktop.py

# 2. 重启 Kimi Code 桌面版, 侧栏账号区上方即出现「Kimi 用量」面板
```

可选——开启自动重装监听(桌面版更新后补丁自动恢复):

```bash
双击 安装自启监听.bat
```

## 原理

桌面版是 Electron 应用,UI 从本地 `resources/desktop-dist/` 明文加载,并内嵌一个免认证的本地服务( kap-server )提供:

| 数据 | 来源 |
|---|---|
| 额度 / 加油包余额 | `GET /api/v1/oauth/usage`(60s 轮询) |
| 实时 token / 速率 / 缓存命中率 | `WebSocket /api/v1/ws` 事件流(`agent.status.updated` 等) |
| 上下文占用 | `GET /api/v1/sessions/{id}/status` |
| 按天消耗统计 | 面板自行从 WS 事件差分积累,存 localStorage |

补丁只做两件事:把 `desktop-patch/kimi-usage-widget.js` 复制进 `desktop-dist/`,并在 `index.html` 的 `</head>` 前加一行 `<script>` 标签。原文件自动备份为 `index.html.bak-kimi-widget`。

## 卸载

```bash
python patch-desktop.py --uninstall
```

如有开启自启监听,先双击 `卸载自启监听.bat`。

## 目录结构

```
├─ patch-desktop.py            安装 / 卸载补丁
├─ watch-patch.py              更新覆盖自动重装监听
├─ desktop-patch/
│  └─ kimi-usage-widget.js     面板本体(单文件零依赖)
├─ 重装补丁.bat                 一键重装(更新被覆盖后手动用)
├─ 安装自启监听.bat / 卸载自启监听.bat
├─ tools/ws-test.js            WS 协议调试小工具
├─ extras/standalone-widget/   番外:独立窗口版用量小组件(本地 HTTP 服务 + 页面)
└─ docs/PLAN-A.md              设计文档
```

## 兼容性

- 已验证:Kimi Code 桌面版 1.0.1(内嵌服务 2.0.0),Windows 11
- 桌面版大版本更新若改动 UI 结构(挂载点 `.side-footer`)或接口,面板可能失效;面板会退化为左下角浮动卡片并显示错误原因

## 免责声明

非官方项目,与 Moonshot AI 无关。本补丁通过修改本机应用文件生效,仅供个人学习研究,使用风险自负。不包含也不分发任何 Kimi Code 官方代码。

## License

MIT
