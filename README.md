# dsh-remote-backend

[dsh-remote](https://github.com/WILSONowo/dsh-remote) 的服务器后端，用于电脑插件与手机之间的中转通信。仅提供后端，没有管理网页。

## 安装

需要 Node.js 22 或以上。

```sh
npm ci
npm run build
npm test
```

## 配置

生成配置（目标目录必须不存在）：

```sh
node src/provision.mjs ./relay-private my-pc https://relay.example.com:8443
```

生成两个文件：

- `server.json`：服务器配置，保存主机 ID 及注册凭证的 SHA-256 摘要。
- `plugin-secret.json`：电脑插件配置，包含明文注册凭证。私密保存，不提交仓库或交给手机。

编辑 `server.json`：

- `bind`：监听地址，默认 `127.0.0.1`；需要外部访问时明确设置目标监听地址。
- `port`：HTTPS 端口，默认 `8443`。
- `tls.cert` / `tls.key`：证书链和私钥的文件路径。相对路径以启动目录为基准。
- `hosts`：主机 ID 到注册凭证摘要的映射，可配置多台电脑。

启动（Linux / macOS）：

```sh
DSH_RELAY_CONFIG=./relay-private/server.json npm start
```

PowerShell：

```powershell
$env:DSH_RELAY_CONFIG='./relay-private/server.json'
npm start
```

电脑插件进入「远程控制 → 服务器」，填写相同的 HTTPS 地址、主机 ID 和生成的注册凭证，启用在线服务。
手机选择「服务器」，填写相同地址和主机 ID，再输入电脑配对码；手机不填写注册凭证。
使用自签名证书时，电脑插件配置 CA 文件，手机导入 CA 证书。

`GET /healthz` 返回健康状态。更新服务器配置后重启此进程；注册凭证轮换时同步更新电脑插件。

## 边界与测试

服务器终止 TLS，可读取转发内容；当前不是端到端加密。无消息数据库、离线执行或失败请求自动重放。
在线主机注册表位于单个进程内；电脑离线返回 503，同一主机重复注册返回 409。

默认测试只使用合成数据与本机随机端口，不访问实际部署。TLS 测试用 OpenSSL 现场生成临时证书；可通过 `OPENSSL_BIN` 指定程序路径。
实际部署或外部网络测试必须另行显式配置目标和凭证。`allowInsecureLoopback: true` 仅供本机 HTTP 开发，手机中转仍要求 HTTPS。

协议 v1 与电脑插件的 `tunnel.ts` 配套；修改协议时需按 [客户端测试说明](https://github.com/WILSONowo/dsh-remote/blob/main/docs/testing.md) 显式运行跨仓库联调。

## 许可

[MIT](LICENSE)。中转协议代码源自 [dsh-remote](https://github.com/WILSONowo/dsh-remote)，保留上游版权声明；维护者 WILSONowo。
