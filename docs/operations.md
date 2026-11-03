# 配置与维护

本文为通用示例。配置、数据库、备份和状态文件应放在仓库外，由专用服务用户持有；Linux 目录权限 0700、文件 0600，Windows 另行限制目录 ACL。管理命令只读写本机文件，没有公网管理接口。设备用户无需运行这些命令。

## 配置项

以下可选项位于 `server.json` 顶层；不填写时使用默认值。数字必须为正整数，通道上限不能超过协议的 64。

| 配置 | 默认值 | 用途 |
| --- | ---: | --- |
| `maxSockets` / `maxAgents` | 512 / 256 | 总 TCP 连接 / 在线电脑 |
| `maxRequests` / `maxRequestsPerHost` | 256 / 48 | 同时转发的 HTTP、SSE、WebSocket |
| `maxFiles` / `maxFilesPerHost` | 8 / 2 | 文件传输并发，必须小于对应总请求上限 |
| `fileBytesPerSecond` | 262144 | 每个文件请求每方向每秒字节数，约 256 KiB/s |
| `maxBodyBytes` | 67108864 | 单次上传上限，64 MiB |
| `requestTimeout` | 60000 | 普通 RPC 从接入到响应结束的总时限，毫秒 |
| `fileIdleTimeout` | 60000 | 文件传输连续无进展时限 |
| `streamIdleTimeout` | 120000 | SSE / WebSocket 无数据时限；正常心跳刷新计时 |
| `handshakeTimeout` | 15000 | 设备 WebSocket 上游握手时限 |
| `duplicateProbeTimeout` | 1500 | 重复电脑连接的旧连接探测时限 |
| `revocationInterval` | 500 | 检查电脑禁用 / 撤销的周期 |
| `shutdownTimeout` | 5000 | 停止接收新连接后的最长排空时间 |
| `requestsPerMinute` / `registrationsPerMinute` | 600 / 20 | 每个来源每分钟的请求 / 注册上限 |
| `maxRateEntries` | 4096 | 各限流表最多记录的来源数 |
| `trustedProxies` | `[]` | 信任的代理 IP / CIDR，默认忽略转发头 |
| `statusFile` | 数据库路径加 `.status.json` | 私有汇总状态文件，每 5 秒更新 |

文件专项限制目前匹配 `/api/remote-access/fs/read`、`/api/remote-access/fs/write`，含查询参数。新增文件 API 时须同步匹配规则和测试。文件流使用空闲超时，不因正常慢速传输超过 RPC 总时限而中断；请求头和注册请求正文另有超时保护。长连接占用请求名额，文件上限预留了控制请求容量。超限直接拒绝，不排队或自动重放操作。

`trustedProxies` 只填实际代理地址，不能填所有地址。仅当直接连接来源受信时才解析 `X-Forwarded-For`，从右向左跳过可信代理，在首个不可信地址停止；格式错误拒绝请求。它只用于本服务限流，不把转发头传给电脑。

## Nginx 与服务进程

[Nginx 示例](../examples/nginx.conf.example) 由 Nginx 提供 TLS，后端仅回环监听。在服务器配置中删除 `tls`，明确设置 `allowInsecureLoopback: true` 和 `trustedProxies: ["127.0.0.1/32"]`。回环 HTTP 不能直接暴露公网；电脑和设备仍填写外部 HTTPS 地址。若前面还有 CDN / 其他代理，需单独建立真实来源信任链，不能直接照抄此单代理示例。

[systemd 示例](../examples/dsh-remote-backend.service) 使用专用非登录用户、只读程序目录和独立可写状态目录。先创建该用户、安装依赖并构建，再按实际目录修改示例；不要覆盖其他服务配置。示例关闭请求日志，使用下述聚合状态诊断。

直接由 Node 提供 TLS 时，证书续期完成后发送 `SIGHUP`（Linux / macOS）或运行对应服务的 reload。只重读原配置中的证书和私钥，验证匹配及有效期后替换；失败保留原证书，已有连接保持。Windows 需由服务管理器安排重启。Nginx 终止 TLS 时按 Nginx 自身续期 / reload 流程处理。其他配置变化需要重启。

`SIGTERM` / `SIGINT` 停止接收新连接，等待活动转发结束，到达 `shutdownTimeout` 后关闭剩余连接。维护者应设置服务管理器停止时限大于此值。应用不会重放中断的写请求。

## 本地管理

以下路径和 ID 均为占位示例，替换成维护者自己的私有文件。列表不输出凭证摘要，但包含电脑名称和 ID，不应粘贴到公开日志。

```sh
node src/admin.mjs list --database /var/lib/dsh-remote/hosts.sqlite
node src/admin.mjs disable --database /var/lib/dsh-remote/hosts.sqlite --id HOST_ID
node src/admin.mjs enable --database /var/lib/dsh-remote/hosts.sqlite --id HOST_ID
node src/admin.mjs revoke --database /var/lib/dsh-remote/hosts.sqlite --id HOST_ID
node src/admin.mjs cleanup --database /var/lib/dsh-remote/hosts.sqlite --before 2026-01-01
```

`disable` 可恢复，`revoke` 永久撤销该身份。默认约 500ms 内服务会关闭对应在线通道；终端观察到断开还受网络传播影响。撤销后旧凭证不能重新注册或启用，撤销记录不计入有效电脑容量。此功能撤销的是整台电脑的服务器接入；单个设备的权限仍由电脑插件管理。

`cleanup` 默认只显示匹配数量，加 `--apply` 才清除截止日期前已撤销记录的显示名称。保留身份及凭证摘要作为撤销记录，不删除有效电脑，也不会让旧身份重新获得接入权限。开放自动注册时，撤销不等于封禁某个人：拥有新安装身份的人仍可重新注册；本版本未引入账号或邀请体系。

## 状态与备份

`GET /healthz` 是进程存活检查；`GET /readyz` 检查注册表是否可读，失败返回 503，不公开数据库错误。私有状态包含在线数、并发、拒绝 / 超时 / 错误及 HTTP 正文字节计数，不包含设备名、IP、凭证或内容；计数从进程启动重新累计，不是计费流量。

```sh
node src/admin.mjs status --file /var/lib/dsh-remote/hosts.sqlite.status.json
node src/admin.mjs backup --database /var/lib/dsh-remote/hosts.sqlite --out /private-backups/hosts-backup.sqlite
node src/admin.mjs verify --source /private-backups/hosts-backup.sqlite
node src/admin.mjs restore --source /private-backups/hosts-backup.sqlite --out /var/lib/dsh-remote/hosts-restored.sqlite
```

状态超过 15 秒未更新会标记 `stale`，停机期间保留最后快照。备份使用 SQLite 一致性快照，包含 WAL 中已提交的数据，并验证结构及记录；目标必须不存在。恢复也只允许新路径，完成后再停服务、修改数据库配置路径并启动，禁止覆盖运行中的数据库。恢复旧备份也会回滚其中的撤销状态，必须选择合适备份并核对列表。

本轮注册表增加状态和最近在线时间，首次启动自动迁移，电脑身份及凭证摘要保持不变。**升级前先备份数据库及服务器配置**；`backup` 可直接备份旧结构，不会先迁移原库。回退程序时同时使用升级前备份的新副本，并保留升级后的数据供核查。证书、私钥及配置单独私密备份，不写入数据库备份或公开仓库。
