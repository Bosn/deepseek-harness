# Agent Note: host.openPath 改走 trusted-hosts 栅栏，不再钉在回环

Status: implemented

[English](2026-08-25-openpath-rides-trusted-hosts.md) | 中文

## Problem

`host.openPath` 被钉在 `dsh-client-connection` 特权方法集的回环限制里（[工具行文件在操作系统打开](../feature/2026-07-28-tool-call-file-open-in-os.zh.md)）：即使部署声明了 `trustedHosts` 权威——并把其余每个 `/api` 方法都服务给这些权威——桌面打开器对任何非回环、同源的浏览器请求仍一律 403。一位运营者刻意把 dsh web 服务给自己拥有的私有网络（Tailscale 尾网，以其 MagicDNS 名称声明为 `trustedHosts` 条目），于是无法从那个浏览器打开产物文件：点击工具行路径会报 "transport failure for /api/host.openPath: HTTP 403"，而页面的其他交互一切正常。

## Decision

`host.openPath` 离开回环钉死的特权集合，改走普通的 `/api` 浏览器信任栅栏：`Host` 为回环或匹配某个已声明的 `trustedHosts` 权威的请求可达打开器，未声明的（外部）权威与其他任何方法一样被拒绝 403。部署的可达性绑定保持不变，仍然是外层边界——这个改动不会授予任何运营者未曾声明的网络。

特权集合的其余部分不动：`host.pickDirectory`（弹出在宿主屏幕上的操作系统对话框）、整个 settings/credentials 配置面、`llm.discoverModels` 与 agent（智能体）preset 创作面在真正的认证层出现之前仍保持回环同源。把桌面打开器授予已声明的权威是运营者的刻意选择：同一个权威本就可以创建由 agent 在此进程上运行 `bash` 的会话，而 [config-plane 决策](2026-07-30-config-plane-boundaries.zh.md)记录了 `trustedHosts` 是 DNS 重绑定栅栏、不是认证层——为其声明一个权威，本就已经授予了比打开文件更多的东西。

## Testing

`packages/client/connection/tests/node-half.host.spec.ts` 在手拼路由与真实 HTTP 服务器两层钉住这条边界：已声明的权威可达 `host.openPath`（桥接运行，以空代理的 404 断言），未声明的权威在桥接之前得到 403，而其余每个特权方法对同一已声明权威仍然 403。

## Alternatives considered

- **在栅栏中识别 Tailscale 地址**——仅对此方法接受 `100.64.0.0/10`（或 Tailscale ULA 前缀）的 Host：否决。栅栏按设计只看请求头（[api 浏览器信任边界](2026-07-28-api-browser-trust-boundary.zh.md)），浏览器以 MagicDNS 名称而非 IP 字面量访问宿主，而且把某个 VPN 厂商的地址空间写进 connection 插件，等于把可达性策略变成栅栏刻意回避的包内部状态。
- **新增一个按方法的配置键**（`openPathTrustedHosts` 之类）：作为没有现实消费者的机制而否决——部署现有的 `trustedHosts` 授权恰好就是运营者想为打开器授权的集合，第二份重叠清单会成为同一边界的第二事实源。
- **以回环 socket 地址检查取代头栅栏**：否决——它会重新引入 [api 浏览器信任边界](2026-07-28-api-browser-trust-boundary.zh.md)丢弃的 socket 检查，而且 socket 地址根本无法表达具名权威。

## Consequences

- Tailscale（或任何运营者声明的）权威可以在宿主桌面上打开产物文件；外部、未声明的 Host 仍被同一道栅栏拒绝。
- `host.describe.canOpenPath` 不变：它仍然宣告这次交接能否抵达用户可见的桌面，而不是谁可以调用它。
- 客户端无需改动：工具行的打开动作从未在客户端侧设门，其失败对话框（[工具行文件打开失败](../bug-fix/2026-08-18-tool-row-file-open-failure.zh.md)）已经会把 Host 拒绝连同重试展示出来。
- `host.pickDirectory` 与配置面保持回环钉死；[web 配置面](2026-07-30-web-config-plane.zh.md)与[工具行文件打开](../feature/2026-07-28-tool-call-file-open-in-os.zh.md)两份 Note 现引用本 Note 说明 `host.openPath` 的例外。
