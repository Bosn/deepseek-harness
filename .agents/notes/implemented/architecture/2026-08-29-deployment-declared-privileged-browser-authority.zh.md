# Agent Note: 部署声明式 Host 配置权威

Status: implemented

[English](2026-08-29-deployment-declared-privileged-browser-authority.md) | 中文

## 问题

每项 Host 操作都要求同一个已认证浏览器会话，但浏览器仅根据 loopback hostname 选择 Host 支撑的配置客户端。因此，通过受信任远程权威提供的已认证页面仍会选择进程内设置镜像，完全不发出 `settings.describe`，即使同一会话能够调用 Host API。

`isLoopback` 还控制依赖本地桌面的浏览器行为。把任意部署 hostname 当作 loopback，会启用仅限原生环境的界面，并把传输位置与是否显示 Host 配置控件的选择混为一谈。

## 决策

connection 插件提供独立的部署声明 `privilegedHosts`。其条目采用与 `trustedHosts` 相同的规范形 `host[:port]` 规则：显式端口仅精确匹配，不带端口的条目匹配所有端口。Loopback 无需此声明即可渲染 Host 配置。`privilegedHosts` 与 `trustedHosts` 共同组成 Host 与 Origin 可达性集合，因此同一个权威不必在两份列表中重复；每个请求仍要求同一个浏览器会话，且该声明不增加任何逐方法权限。

Host 把声明以 `__DSH_PRIVILEGED_HOSTS__` 注入所提供的文档。浏览器根据 loopback 或当前页面权威的精确匹配派生 `ctx.connection.canUseHostConfiguration`，API Gateway 再将这项固定事实映射为 `ctx.remote.$host.canUseHostConfiguration`。Settings 根据该 Remote 事实选择 Host 支撑的客户端；桌面专属行为仍以 `isLoopback` 为真源。畸形或缺失的注入会让远程页面保留进程内镜像。

这项声明既不是认证，也不是逐方法 API 访问控制列表。进程 token 交换与签名浏览器会话 cookie 统一认证每项 Host 操作；Host 与 Origin 检查把 `trustedHosts` 与 `privilegedHosts` 的并集作为请求路由策略。部署应尽可能把每个 `privilegedHosts` 条目限制到预期端口，使只有预期页面渲染这些控件。

## 曾考虑的替代方案

- **让 `trustedHosts` 选择 Host 配置**——否决，因为这会在每个既有远程部署中显示配置控件。即使两者都要求同一个浏览器会话，请求可达性与界面暴露仍是两项独立声明。
- **在浏览器中把远程部署归类为 loopback**——否决，因为 `isLoopback` 还会启用桌面专属行为。传输位置与 Host 配置能力仍是两项独立事实。
- **依赖代理重写请求头**——否决，因为它只改变服务器的视角。页面会在发出 settings 请求前选择内存镜像，因此代理重写无法显示这些控件。
- **在每个已认证远程页面渲染 Host 配置**——否决，因为认证回答谁能使用 Host API，而不是哪个部署打算远程显示配置控件。部署会显式点名该页面权威。

## 影响

位于显式声明远程权威的已认证浏览器会与 loopback 加载、修改同一份设置文档，因此 Models 设置可以通过该部署工作。未声明的远程页面仍停留在进程内，并且配置界面不发送 settings 请求。请求通过 Host 与 Origin 组合策略及浏览器会话认证后，无论由哪份列表准入路由，每项 Host API 方法都拥有相同权限。测试钉住了规范权威匹配、浏览器能力派生、两种 settings 客户端模式，以及组装后的已授权与未授权远程 Models 路径。
