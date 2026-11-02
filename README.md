# dsh-remote-backend

[dsh-remote](https://github.com/WILSONowo/dsh-remote) 的服务器后端，用于电脑插件与手机之间的中转通信。仅提供后端，没有管理网页。

## 安装

需要 Node.js 22.13 或以上（使用内置 SQLite）。

```sh
npm ci
npm run build
npm test
```

## 配置

生成配置（目标目录必须不存在）：

```sh
node src/provision.mjs ./relay-private
```

编辑生成的 `server.json`：

- `bind`：监听地址，默认 `127.0.0.1`；需要外部访问时明确设置目标监听地址。
- `port`：HTTPS 端口，默认 `8443`。
- `tls.cert` / `tls.key`：证书链和私钥的文件路径。相对路径以启动目录为基准。
- `registration.enabled`：是否允许新电脑自动注册，生成配置默认开启。开启后，能访问注册接口的客户端可以登记电脑；手机控制权限仍须在对应电脑上配对取得。
- `registration.database`：持久 SQLite 文件路径。生成工具使用新配置目录中的绝对路径；迁移部署时更新该路径并保留数据库。
- `registration.maxHosts`：自动注册电脑数量上限，默认 `1000`。每个来源 IP 每分钟最多 20 次注册请求；不信任客户端提供的代理 IP 头。

启动（Linux / macOS）：

```sh
DSH_RELAY_CONFIG=./relay-private/server.json npm start
```

PowerShell：

```powershell
$env:DSH_RELAY_CONFIG='./relay-private/server.json'
npm start
```

电脑插件进入「远程控制 → 服务器中转」，填写 HTTPS 地址和电脑名称，开启中转开关并保存。身份与注册凭证自动保存，无需用户操作服务器。
自动注册与扫码流程需搭配 `dsh-remote` App 和插件 3.1.0 或以上。
电脑点击「添加手机」，手机首页扫码或粘贴连接信息，随后在电脑确认。多台手机分别配对，可控制同一台电脑，并单独撤销。
自签名证书需在电脑插件配置 CA 文件；手机可先保存对应连接记录并导入 CA，再重新扫码配对。

新增电脑不修改服务器配置、不重启服务。`GET /healthz` 返回健康状态。修改监听地址、TLS 或注册策略等服务器配置后需要重启后端；正常设备注册、配对和改名不需要重启。

## 迁移与数据

2.0.0 起仅支持自动注册，不再接受静态 `hosts` 字段或旧版逐台电脑生成配置的命令。维护者先在仓库外备份现有私密配置和数据库，再删除 `hosts` 字段并配置 `registration`，保留监听、TLS 和已有自动注册数据库，最后重启服务。不要用生成工具覆盖现有配置，也不要导入旧静态凭证。
旧手动中转的电脑需重新填写服务器地址并启用，手机删除旧中转记录后重新扫码。已有自动注册身份保持有效。

自动注册数据库保存电脑标识、凭证摘要、显示名称和登记时间，不保存明文注册凭证。数据库及服务器私密配置不提交仓库；应备份数据库。关闭 `registration.enabled` 并保留数据库配置只停止新注册，已登记电脑仍能连接。
在线隧道在单个进程内维护，暂不支持多实例共享路由。电脑离线返回 503，同一电脑身份重复在线返回 409。数据库身份跨重启保留。

## 边界与测试

服务器终止 TLS，可读取转发内容；当前不是端到端加密。无消息数据库、离线执行或失败请求自动重放。
注册电脑不会授予手机控制权限，手机仍需在电脑上单独确认配对。

默认测试只使用合成数据与本机随机端口，不访问实际部署。TLS 测试用 OpenSSL 现场生成临时证书；可通过 `OPENSSL_BIN` 指定程序路径。
实际部署或外部网络测试必须另行显式配置目标和凭证。`allowInsecureLoopback: true` 仅供本机 HTTP 开发，手机中转仍要求 HTTPS。

协议 v1 与电脑插件的 `tunnel.ts` 配套；修改协议时需按 [客户端测试说明](https://github.com/WILSONowo/dsh-remote/blob/main/docs/testing.md) 显式运行跨仓库联调。

## 许可

[MIT](LICENSE)。中转协议代码源自 [dsh-remote](https://github.com/WILSONowo/dsh-remote)，保留上游版权声明；维护者 WILSONowo。
