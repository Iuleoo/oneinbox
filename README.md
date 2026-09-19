# OneInbox

一个自托管的多邮箱聚合客户端。把 Gmail、Outlook、QQ 邮箱、网易 163 等多个邮箱的邮件聚合到一个清爽的三栏界面里，专注收件与阅读。

## 功能

- 多账户：IMAP 协议，支持授权码登录（QQ / 163 / 自定义）与 OAuth2 授权（Gmail / Outlook）
- 统一收件箱 + 分账户视图 + 全部文件夹（已发送、垃圾邮件、已删除、自定义文件夹）
- 邮件正文净化后在沙箱中渲染，远程图片默认拦截；附件预览与下载
- 已读 / 星标 / 删除 / 批量操作，本地更新并回写到邮箱服务器
- 实时推送（IMAP IDLE）与主动探测相结合，适配不推送的服务商
- 全文搜索，支持 `from:` `has:attachment` `is:unread` `in:junk` 等前缀
- 深色模式、键盘快捷键、响应式布局与移动端滑动手势
- AES-256-GCM 加密存储；单文件 SQLite；Docker 一键部署

## 技术栈

| 层 | 选型 |
|---|---|
| 后端 | Node.js 20 · TypeScript · Fastify · imapflow · Drizzle ORM · SQLite (FTS5) |
| 前端 | React 18 · Vite · Tailwind CSS v4 · Radix UI · TanStack Query / Virtual |
| 部署 | Docker（单容器，后端托管静态前端） |

## 快速开始

```bash
cp .env.example .env          # 按需填写；首次启动会自动生成主密钥，务必备份 data/master.key
docker compose -f docker/docker-compose.yml up -d --build
# 打开 http://localhost:8080，首次访问会引导创建管理员账号
```

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | 监听端口 |
| `DATA_DIR` | `/data`（容器内） | 数据库、主密钥、日志所在目录 |
| `MASTER_KEY` | 自动生成 | 32 字节 hex，用于加密邮箱凭据；留空则读写 `DATA_DIR/master.key` |
| `BASE_URL` | `http://localhost:8080` | 用户访问的地址，OAuth 回调以此为准 |
| `INIT_USERNAME` / `INIT_PASSWORD` | — | 首次启动自动创建管理员；留空则由 `/setup` 页面创建 |
| `PROXY_URL` | — | 出站代理，`http://host:port` 或 `socks5://host:port`。服务器在国内接 Gmail 时必需 |
| `PROXY_FOR` | `gmail` | 走代理的服务商，逗号分隔 |
| `LOG_LEVEL` | `info` | 日志级别 |

备份只需复制 `data/` 目录；`master.key` 丢失则所有账户凭据不可恢复。

## 本地开发

```bash
pnpm install
cp .env.example .env
pnpm dev            # server :8080 + web :5173
pnpm typecheck
pnpm test
```

## OAuth 应用注册

- **Gmail**：Google Cloud Console 创建 OAuth 客户端（Web 应用），scope `https://mail.google.com/`，回调地址 `<BASE_URL>/oauth/google/callback`。
- **Outlook**：Microsoft Entra 注册应用，账户类型选"任何组织目录中的账户和个人 Microsoft 账户"，回调地址 `<BASE_URL>/oauth/microsoft/callback`（Microsoft 只接受 https 或 localhost）。

回调地址不在本服务上时（例如登记的是 `localhost`），授权后把浏览器跳转到的完整 URL 粘回添加账户向导即可完成。

## License

MIT
