---
description: "Web GUI 的浏览器-Host 线层：带认证的 Remote RPC、可重连事件投递，以及可选的隔离工作区文件源。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-connection

[English](README.md) | 中文

## 概述

本包承载浏览器到 Host 的 Remote 调用、精确 Fetch 响应与 connection generation。Client 插件挂载 `ctx.connection`，其中包含当前页面的 loopback 状态、通用 RPC carrier、当前 generation 及其 Host 信息，以及单一 generation source 的注册点。source 报告 ready 后 generation 才可见；source 结束、失败、被撤回或显式 stop 都会清空它，再由 `ConnectionController` 退避重连。

Host 会把 `privilegedHosts` 以 `__DSH_PRIVILEGED_HOSTS__` 注入页面。Client 通过 `ctx.connection.canUseHostConfiguration` 判断随附 UI 是否应在远程页面挂载 Host 侧的设置、凭据、模型提供方及相关配置界面。Loopback 页面以及拥有 Host 的传输始终显示这些界面；served 远程页面只有在其完整 authority 与注入声明匹配时才显示。这是部署级 UI 能力声明，不是 API 访问控制列表：声明的 authority 会加入普通 Host/Origin 信任栅栏，但每个请求仍与其他 Host 操作一样必须持有有效的签名浏览器会话；系统不存在按方法区分的 loopback 层。

可选的 `files` 配置块会绑定第二个 HTTP listener，它只提供 `GET`/`HEAD /f/<sessionId>/<path...>`。独立端口就是独立浏览器 origin，因此活动 HTML 或 SVG 产物保留自己的存储与同源 sibling 请求，却不会与 `/api` 同源。Session Controller 在不激活冷 Agent 的情况下解析 cwd；双重 `realpath` confinement 会拒绝路径穿越与符号链接逃逸。若 `files.port` 与 `files.publicUrl` 都没有键，则 listener 与页面全局都不存在，文件点击继续使用 Host 原生打开器。

## 目录

- [使用本包](#use-this-package)
- [浏览器认证与请求信任](#browser-authentication-and-request-trust)
- [Connection generation](#connection-generation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

浏览器通过 HTTP POST 执行 Remote 一元调用；API Gateway 自己拥有 `/api/remote.mux` WebSocket 及其逻辑流。进程内组合通过 `connection.rpc.open` 提供等价的 Remote 流，不打开 WebSocket。Host half 拥有唯一 `/api` route、Fetch bridge、浏览器认证、Host/Origin 校验与精确 `GET`/`HEAD` 路由注册表。Typert Gateway 认领生成的 Remote endpoint，功能包注册 Session 日志下载等非 JSON 响应，未认领的请求返回 404。Loopback hostname 判定只供浏览器侧当前页面状态使用，留在包内。

要让远程浏览器读取工作区文件，请配置 `files.port`；若由反向代理发布该 socket，再配置其 bare `files.publicUrl`。`publicUrl` 要求固定非零端口，且 hostname 必须与应用 authority 相同：绑定 authority 的应用 cookie 是 host-scoped，因此会到达 sibling port，文件 listener 再校验其签名应用 audience。浏览器只为 Session cwd 内的路径构造文件 URL；越界路径继续走原生打开器回退。

-----

<a id="browser-authentication-and-request-trust"></a>
## 浏览器认证与请求信任

每个 Host RPC 方法和 WebSocket stream 都要求同一个浏览器会话，不存在按方法区分的 loopback 层。每个进程生成一个随机启动令牌。`dsh-web-app` 打印并打开带 `?token=...` 的普通根 URL；`frontend-static` 把根路径和 index 请求交给 `ctx.connection.authorizeIndex`，后者只在 `GET /` 接受该令牌，写入绑定 authority 的签名 cookie，再重定向到干净的 `/`。缺失、过期、畸形或 authority 不匹配的 cookie 会在 RPC 分发前得到 401。静态资源保持公开。HTTP 载体不在根路径交换之外接受 query token，也不接受 Authorization header token。

cookie 签名密钥是 `ctx.credentials` 中由 `client-connection/browser-session` 拥有的 grant 记录。本地提供方把它持久化到 `$DSH_HOME/.credentials.yaml`；`BrowserAuth` 在 Connection 激活期间加载或创建该记录，并把密钥留在内存中，因此请求认证同步执行。删除或替换该记录会在下一次 Connection 激活时生效。cookie 携带绝对签发与过期区间，`cookieMaxAgeDays` 默认设为 30 天，并在确定性名称与签名 payload 中同时绑定规范化 hostname 和 port。它是 host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`；随附服务器使用 loopback HTTP，因此刻意不设置 `Secure`。

认证之前，每个请求仍经过 `src/api-request-trust.ts`。其 `Host` 必须是 loopback，或与 `trustedHosts` 和 `privilegedHosts` 的并集匹配：带端口的 `host:port` 精确匹配，不带端口的条目匹配任意端口，两侧均经 WHATWG 归一化。若附带 `Origin`，它必须等于该 Host；`sec-fetch-site: cross-site` 一律拒绝。两份列表中的畸形 authority 都会让插件加载失败。这些检查防御 DNS rebinding 与跨站浏览器请求，绝不建立身份。Host/Origin 校验失败返回 403；Host 可信但未认证的请求返回 401。认证后所有 Host API 使用同一策略；`privilegedHosts` 只让匹配的远程页面启用随附 Host 配置 UI，绝不绕过或替代浏览器会话。`dsh web --host 0.0.0.0` 仍不受支持。决策记录：[浏览器请求信任](../../../.agents/notes/implemented/architecture/2026-07-28-api-browser-trust-boundary.zh.md)、[浏览器令牌认证](../../../.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md)与[部署声明的 Host 配置 UI](../../../.agents/notes/implemented/architecture/2026-08-29-deployment-declared-privileged-browser-authority.zh.md)。

工作区文件 listener 对自己的有效 authority 应用同一 Host/Origin 栅栏，再只接受由已配置同 hostname 应用 authority 签发的有效浏览器 cookie。它既没有 index，也没有 `/api`；非 `/f` 路径一律 404，写方法一律 405。响应采用流式传输，带 `no-store`、`nosniff` 与显式 inline media type，不带 sandbox header——独立 origin 本身就是隔离边界。

<a id="connection-generation"></a>
## Connection generation

API Gateway Client 把内部 `$events` logical stream 注册为唯一 generation source，与有无 `$on` 订阅无关。Host 在 API Remotes source factory 同步挂好所有增量 listener 后，先发送唯一 `{ type: 'ready', clientId, host: { home } }` 项，再发送事件。`ConnectionController` 仅在收到该 ready 项后发布 generation 并调用 `onConnected`，因此 baseline 不会跑在增量 listener 前面。

`$events` 结束、返回 Remote stream error、收到非 ready 首项或畸形事件项，都会使当前 generation 失效。Controller 立即撤回 generation、发布 `reconnecting`，并在退避后重开 `$events`。Gateway mux 自己负责重建底层 WebSocket；Connection generation 负责重开 logical stream 并建立下一次 baseline 起点。

<a id="model-experience"></a>
## 模型体验

无。协议消费层只在浏览器与主机之间搬运已经组合好的消息；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **`/api` 桥把每个请求体整体缓冲在内存里**：`maxRequestBodyBytes`（默认 300 MiB，按默认 200 MiB 图片总量上限经 base64 膨胀加信封余量得出）因此同时是单请求的驻留内存上界；要降低它而不缩小图片限额，需要流式请求体路径。
- **浏览器 cookie 不带 `Secure`**：随附载体是 loopback HTTP；若部署经明文网络暴露同一 authority，bearer cookie 可能在传输中泄露。
- **没有 logout 操作**：清除浏览器 cookie 会结束单个浏览器会话；删除 owner 凭据记录并重启 `dsh` 会撤销全部会话。
- **工作区文件服务占用第二个 listener 与同 hostname 公网 authority**：反向代理必须单独发布 `files.port`；不同公网 hostname 无法收到 host-only 应用 cookie。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
