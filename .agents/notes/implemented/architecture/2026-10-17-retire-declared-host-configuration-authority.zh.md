# Agent Note: Retire the deployment-declared Host configuration authority

Status: implemented

[English](2026-10-17-retire-declared-host-configuration-authority.md) | 中文

## 问题

[部署声明的 Host 配置权威](2026-08-29-deployment-declared-privileged-browser-authority.zh.md)之所以存在，是因为浏览器从连接位置选择设置存储：非 loopback 页面保留进程内镜像，因此部署必须把其远程权威声明为 `privilegedHosts`，该页面才能访问 Host 设置文档。

dsh-v0.2.1-rc.2 取消了按位置选择存储。[每个已认证浏览器共享 Host 设置文档](../bug-fix/2026-09-15-authenticated-browser-host-preferences.zh.md)：`SettingsDescribeMirror` 与 `ConfigForms` 不再接受持久化选择器，表单只在 Host 未注册该命名空间时报告 `unavailable`。不再有任何受支持的扩展点让位置事实选择设置存储。

## 决策

本 fork 退役该特权声明，而不是保留一个无人据以选择的固定事实。`client-connection` 不再从配置读取 `privilegedHosts`，不再向所提供文档注入 `__DSH_PRIVILEGED_HOSTS__`，也不再派生 `ConnectionHandle.canUseHostConfiguration`；API Gateway 不再把它映射到 `ctx.remote.$host`。`trustedHosts` 仍是 Host/Origin 栅栏唯一的可达性声明，`isLoopback` 仍是桌面专属行为读取的固定传输事实。

独立的 [`browserSessionAuth` opt-out](2026-08-31-browser-session-auth-opt-out.zh.md)保持不变：它仍关闭浏览器会话身份识别，把可达性策略留给栅栏与操作者的网络层。

## 考虑过的替代方案

- **把 `canUseHostConfiguration` 保留为固定客户端事实** — 否决：上游移除存储选择器后该事实没有消费方，而一个不选择任何东西的公开能力会诱导下一位读者重新引入依赖位置的行为。
- **给上游的镜像与表单重新加回持久化选择器** — 否决：这会在同步中回退上游决策，并把每浏览器唯一的设置镜像重新分裂，而这正是上游改动要消除的分裂。
- **把声明的远程权威归类为 loopback** — 以[原始说明](2026-08-29-deployment-declared-privileged-browser-authority.zh.md)中的同一理由否决：`isLoopback` 还会启用远程页面无法使用的桌面专属 UI。

## 结果

此前声明 `privilegedHosts` 的部署失去该键，必须只依赖 `trustedHosts`；未声明的键现在会导致插件加载失败，因此同一次改动中会从所属 profile 移除该声明。每个访问同一 Host 的已认证浏览器共享该 Host 的设置文档，包括受信远程页面；偏好访问由 Connection 认证与 `settings.describe.writable` 治理，与上游文档一致。外层栅栏不变：远程权威仍需要 `trustedHosts`，浏览器会话 opt-out 仍只绕过身份识别而非可达性。

## 验证

连接套件只固定剩余固定事实：loopback 页面、非 loopback 页面与无浏览器位置运行时的 `isLoopback`。上游的 `ui-settings` 镜像与配置表单套件固定无位置选择的行为，无密钥的 `apps/web` remote-settings 场景继续证明受信远程页面通过 Host 持久化偏好。
