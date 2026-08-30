# Agent Note：供远端 Web 客户端使用的已认证工作区文件源

状态：已实现

[English](2026-08-30-workspace-file-origin.md) | 中文

## 问题

Web 文件交互原先把每次点击都委托给 `session/openWorkspacePath`；浏览器位于 Host 桌面时这是正确行为，但另一台机器上的浏览器无法打开远端 EC2 路径。把文件发布在 `/api` 旁边会让 agent 产出的 HTML 获得应用 authority，而一个未认证的第二监听器则会把「知道 Session id」变成读取文件的能力。

## 决策

`@deepseek-ai/dsh-client-connection` 拥有可选的 `files` 部署能力。两个键都不存在时不创建监听器；由于配置层可能把缺失的嵌套对象物化，`files: {}` 也保持无操作。`files.port` 在 Web server host 上绑定专用监听器；`files.publicUrl` 声明对外发布的裸 origin，并要求固定非零端口，且其主机名已存在于应用的 trusted 或 privileged authorities 中。

应用 shell 只接收 `__DSH_FILES__ = { port, publicUrl? }`。浏览器的 `ConnectionHandle.fileUrl()` 只有在工具报告的绝对路径或 cwd 相对路径仍位于 Session cwd 下时，才把它转换成 `/f/<sessionId>/<segments…>`。chat 表面在该 URL 可用时以新标签页打开，否则保留既有的 `session.openWorkspacePath` 回退。

Session Controller 经 `client-connection/workspace-root` waterfall 拥有 Session 到工作区的解析。它对已挂载和已持久化的 Session 都使用 `inspect()`，因此文件读取不会激活 Agent；未知 Session 继续委托且不产生根目录。

## 安全边界

文件监听器只接受 `/f` 下的 `GET` 与 `HEAD`，应用与它使用同一 Host/Origin authority fence，并要求浏览器携带一个为同主机上受允许应用 authority 签发的有效会话 Cookie。浏览器 Cookie 按主机而非端口限定，但签名 payload 仍绑定精确应用 authority，因此同主机的文件端口能够验证既有应用会话，而不会成为自己的认证入口。

处理器解码每个 URL segment 时禁止分隔符、点遍历和 NUL 字节，通过 `realpath` 同时解析 Session cwd 与目标，拒绝符号链接逃逸，只提供普通文件，并以显式 inline MIME、`nosniff` 和 `no-store` 流式传输正文。缺失、不可读和无效目标共享同一 404 响应。所服务文档拥有独立 origin，因此无法把应用 `/api` 当作同源内容调用。

## 考虑过的替代方案

- **在应用 origin 上提供文件**——否决，因为 agent 产出的动态 HTML 会继承应用的 `/api` authority。
- **对同源文件施加 `Content-Security-Policy: sandbox`**——否决，因为它会破坏生成 HTML 之所以有用的存储与动态脚本行为，同时仍保留不必要的路由复杂度。
- **不经 BrowserAuth 暴露第二监听器**——否决，因为 Session id 是路由身份而非授权，并且可能出现在浏览器历史、日志或复制的链接中。
- **签发一次性文件 capability URL**——本部署路径未采用，因为它会增加过期、重放与泄漏处理语义；应用已经拥有可安全复用于同主机 sibling port 的持久签名浏览器会话。

## 验证

聚焦的 Host 与 Client 测试覆盖 URL 构造与解析、认证、authority 派生、配置启用语义、监听器生命周期、遍历与符号链接逃逸、冷/已挂载 Session 查询、浏览器弹窗选择和原生回退。每个改动源文件的逐文件覆盖率均为 100%。

Web 组合 E2E 以操作系统分配的文件端口启动应用，经真实 BrowserAuth 流程认证，点击实际产出文件标签项，并验证弹窗路径、文件字节、独立 origin、响应头、动态 HTML 行为、被阻断的应用 API 访问、路由隔离与遍历拒绝。

## 结果

发布额外端口的远端部署可以直接在用户浏览器里打开产出文件，同时不把应用 authority 交给这些文档。默认部署和桌面部署不会增加监听器，也不会改变打开行为。反向代理必须单独发布配置的文件端口，且文件 public hostname 必须与应用 hostname 一致，既有浏览器会话才能到达它。
