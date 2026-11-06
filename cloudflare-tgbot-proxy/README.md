# Telegram Bot API Cloudflare Worker 中转

将本仓库中的 Worker 脚本部署到 Cloudflare Workers 后，可作为 `api.telegram.org` 的反向代理，供内网 / 受限网络环境的客户端访问 Telegram Bot API。

当前线上域名示例：`https://telegram_bot.example.com`

---

## 背景与用途

部分运行环境无法直连 `api.telegram.org`，但可以访问 Cloudflare。客户端把 Bot 请求发到本 Worker，由 Worker 再转发到 Telegram 官方 API。

典型调用形态（与官方一致，仅替换主机名）：

```text
https://telegram_bot.example.com/bot<BOT_TOKEN>/<method>?<query>
```

例如：

- 发文字：`GET /bot<token>/sendMessage?chat_id=...&text=...`
- 发图片：`POST /bot<token>/sendPhoto`（`multipart/form-data`，字段含 `chat_id`、`photo` 文件、可选 `caption`）
- 发文件：`POST /bot<token>/sendDocument`（同上，文件字段名为 `document`）

本仓库对应业务侧（`tg-task-client`）会用该中转发送：

- 日常 / 严重错误告警文本
- 私聊收到的图片（本地下载后经机器人 `sendPhoto` 转发到告警群）

---

## 核心实现说明

Worker 只做一件事：**把入站请求的 method、headers、body 原样转到** `https://api.telegram.org/bot<token>/<method>`。

### 必须正确转发的内容

| 项目 | 说明 |
|------|------|
| `method` | GET / POST 等 |
| `headers` | 尤其是 `Content-Type`（multipart 时必须带 `boundary`） |
| `body` | POST 的表单或文件流；不可丢弃 |

### 历史坑（已在脚本中规避）

错误写法示例：

```js
const { url, ..._request } = request;
await fetch(api_url, _request);
```

`Request` 对象不能按普通对象解构/展开，展开后几乎是空对象，导致：

- GET + query 的 `sendMessage` 仍可能正常（参数在 URL 上）
- POST multipart 的 `sendPhoto` / `sendDocument` **丢失 body**，Telegram 返回类似：

```json
{"ok":false,"error_code":400,"description":"Bad Request: there is no photo in the request"}
```

且部分网关/环境会出现 **HTTP 200 + `ok:false`**，客户端不能只看 HTTP 状态码，必须解析 JSON 的 `ok` 字段。

正确做法：显式构造 `fetch` 的 `init`：

```js
{
  method: request.method,
  headers: /* 复制并去掉 host 等 */,
  body: request.body,   // POST 时
  duplex: 'half'        // Workers 流式转发 body 时需要
}
```

---

## 路径约定

路径正则：

```text
/^\/bot(?<bot_token>[^/]+)\/(?<api_method>[A-Za-z0-9]+)$/
```

- `bot_token`：Telegram Bot Token（含冒号），如 `123456:AA...`
- `api_method`：Bot API 方法名，如 `sendMessage`、`sendPhoto`、`sendDocument`

Query string（`?chat_id=...&text=...`）会原样拼到官方 URL 后。

---

## 部署（Cloudflare Workers）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Workers & Pages → Create Worker  
2. 将本仓库中的 Worker 脚本（如 `worker.js`）粘贴保存并 Deploy  
3. 绑定自定义域名（例如 `telegram_bot.example.com`）到该 Worker  
4. 用下面命令自测（把 token / chat_id / 图片路径换成自己的）

### 自测：发文字

```bash
curl -sS "https://telegram_bot.example.com/bot<BOT_TOKEN>/sendMessage?chat_id=<CHAT_ID>&text=hello"
```

期望响应包含 `"ok":true`。

### 自测：发图片（multipart）

```bash
curl -sS -X POST "https://telegram_bot.example.com/bot<BOT_TOKEN>/sendPhoto" \
  -F "chat_id=<CHAT_ID>" \
  -F "caption=photo_test" \
  -F "photo=@/path/to/test.jpg"
```

期望响应包含 `"ok":true` 且 `result.photo` 存在。  
若仍出现 `there is no photo in the request`，说明 body / Content-Type 仍未正确转发，需再检查 Worker 是否使用了最新脚本。

---

## 安全注意

- Worker **不负责鉴权**：任何知道 URL 与 Bot Token 的人都可以调用。Token 相当于密钥，勿提交到公开仓库；若泄漏请立即在 BotFather 轮换。  
- 建议：仓库仅存脚本与本文档，**不要**写入真实 `BOT_TOKEN`、业务 `chat_id`。  
- 如有需要，可在 Worker 前加 Cloudflare Access、自定义 Header 校验或 IP 限制（需同步改客户端）。

---

## 与客户端的配合要点

业务客户端（Python）侧建议：

1. 文本：`GET .../sendMessage?...`（或等价封装）  
2. 图片：`POST multipart` 到 `.../sendPhoto`，字段名 `photo`；失败可回退 `sendDocument`  
3. 判断成功：`response.json()["ok"] is True`，不要只判断 `status_code == 200`

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `worker.js`（或你命名的入口脚本） | Cloudflare Worker 主逻辑 |
| `README.md` | 本说明 |

---

## 许可

内部备份用途。按团队约定使用即可。
