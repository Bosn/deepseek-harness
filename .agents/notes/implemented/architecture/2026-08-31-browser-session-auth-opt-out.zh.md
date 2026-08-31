# Agent Note: Deployment browser-session authentication opt-out

Status: implemented

[English](2026-08-31-browser-session-auth-opt-out.md) | 中文

## 问题

[浏览器启动令牌认证](2026-08-24-browser-token-authentication.zh.md)模型要求每个浏览器都持有签名会话，即使部署的网络层已经决定了谁能触达 socket。在 overlay 网络或带认证的反向代理后面服务的操作者，仍需在每个新浏览器上、在每次进程重启后消费打印出来的 `?token=...` URL，并且必须把启动行当作凭据处理。会话层看不到网络的准入决定，但此前没有任何受支持的配置可以把它关掉，因此这类操作者只能给 harness 打补丁或干脆不用 Web 表层。

## 决策

`dsh-client-connection` 增加经校验的 `browserSessionAuth` 配置，默认 `true`。部署把它设为 `false` 时，Connection 激活会选择 `BrowserAuth.bypass()` 而不是创建签名密钥认证器：每个入口——`authorizeIndex`、`isAuthenticated`、`isAuthenticatedFor` 和 `authenticatedUrl`——都无条件放行或打印干净 URL，启动令牌交换与签名 cookie 逻辑则保持不变，继续服务默认部署。`dsh-web-app` 于是打印不带 `?token=...` 的普通根 URL，index、`/api` 与工作区文件请求只需通过既有检查即可获得服务。

该 opt-out 关闭的是身份识别，绝不是可达性策略。[Host/Origin 信任栅栏](2026-07-28-api-browser-trust-boundary.zh.md)仍作用于每个 `/api` 与工作区文件请求，随附 CLI 仍拒绝 `--host 0.0.0.0`，`privilegedHosts` 仍然只决定是否显示 Host 配置 UI。封闭责任落到操作者的网络层（绑定、代理认证或 overlay 网络成员资格）外加栅栏。

## 验证

`BrowserAuth` 单元套件固定 bypass 模式：index 与请求检查全部通过，sibling authority 检查通过，打印的 URL 不带 token。真实 CLI e2e 写入设置 `browserSessionAuth: false` 的 `$DSH_HOME/cordis.patch.yml`，启动 `dsh web`，证明免会话请求能取到 index 并派发 `settings/describe`。

## 备选方案

**把随附默认值改成 `false`。** 那会给每个部署移除令牌交换——包括单用户 loopback 桌面，会话层本来保护它免受同机或 LAN 路人的请求——并重写整套默认行为测试面。认证保持默认的配置项让产品姿态不变，把改动限制在激活和入口。

**复用 `trustedHosts` 为所列 authority 跳过认证。** 可达性列表会变成身份授权：任何能发出所列 `Host` 的调用者都能自我认证，而那正是栅栏要封堵的 confused-deputy 路径。两层分开能让栅栏继续可审计。

**从配置或环境接受固定 token。** 持久 token 是第二个长期 bearer 凭据，还要新的轮换机制。bypass 让网络层拥有准入，而不是铸造一个进程仍需保护的更弱凭据。

**为带认证的代理增加转发 header 信任。** 没有已交付的消费方解析转发 header；在没有代理契约的情况下信任它们，会让任何直连调用者声称拥有代理授予的身份。

## 后果

`browserSessionAuth: false` 的部署把完整工具型 Host API 只交给网络层与信任栅栏把关；暴露配置错误等于把远程代码执行权交给任何能触达端口的人。字段名、JSDoc 与 connection README 都写明这个权衡，而不是藏起开关。

默认部署保留不变的令牌加 cookie 行为，因此这是一个未来认证工作可并排 merge 的入口 seam。bypass 模式下启动 URL 不含凭据，但操作者失去打印的登录行，必须先把网络层准入控制部署到位再关闭该层。

[令牌认证说明](2026-08-24-browser-token-authentication.zh.md)与[信任说明](2026-07-28-api-browser-trust-boundary.zh.md)仍是默认模式与栅栏的有效权威；没有 active Agent Note 被归档，因为这是增量而非取代。