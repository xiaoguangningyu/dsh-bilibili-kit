# dsh-bilibili-kit

给本机 DSH 用的 B 站字幕/简介读取插件。**登录态只在本机**：面板扫码 → 插件自己把 SESSDATA 存进
`~/.dsh/bilibili-kit/state.json`，不经过聊天、不进工作区、不出本机。

## 它能做什么

| 能力 | 位置 | 说明 |
|---|---|---|
| 读取视频标题 / 简介 / 分P / 统计 | 工具 `bilibili_video` ／ 面板 | 匿名可用，不需要登录 |
| 读取字幕清单（语种、是否 AI） | 同上 | **需要登录**；未登录时清单为空是正常现象 |
| 读取字幕正文（带时间戳） | 工具 `bilibili_subtitle` ／ 面板 | 需要登录；可 `save_to` 直接落盘 |
| 扫码登录 / 退出登录 | 面板 | 二维码由本机生成，不经过第三方服务 |

它**不做**：下载视频、绕过付费/会员/充电专属内容、点赞评论转发。字幕只用来给你自己看和总结。

## 安装（桌面端 desktop profile）

桌面应用的 CLI 不管理 `desktop` profile（内核写死），所以走界面：

1. 侧栏打开「插件」页（副标题「安装、启用和配置插件」），点「添加插件」；
2. 填**本地绝对路径**：

   ```
   D:\Asus\Documents\ds-harness-test1\dsh-bilibili-kit
   ```

3. 安装完成后它会被自动加进 profile 的 `dsh.profile.bundles`；
4. 重启 DSH（或按插件页提示重载）。

> 卸载：插件页移除即可。登录态若想同步清除，删掉 `~/.dsh/bilibili-kit/` 整个目录。

## 使用

**设置页（推荐）**：重启后打开「设置」，左侧导航会多一个 **「B 站字幕工具」** 分区，
里面就是完整面板（扫码登录 / 查询 / 复制字幕），不用再开浏览器标签。

**面板**：也可以用 `sidebar_open` 或浏览器访问 `http://127.0.0.1:<端口>/bilibili-kit`
（端口以本机 DSH 为准，通常是 43120）。

1. 点「扫码登录」，用手机 B 站 App 扫码并确认；
2. 粘贴视频链接 / BV 号，点「读取」；
3. 选语种，可「查看字幕」「复制字幕纯文本」——复制后贴回对话，让 AI 基于它总结。

**对话里**：装好后直接说"读一下这个视频的字幕 BV1xx411c7mD"，agent 会调
`bilibili_video` 再调 `bilibili_subtitle`；字幕工具支持 `save_to` 写到任务资料夹。

**登录态有效期**：SESSDATA 约 180 天，存 `~/.dsh/bilibili-kit/state.json`；过期或被风控踢下线才需重扫。

**设置页分区的实现**：浏览器半身 `client.js` 往 `settings.section` 槽位注册分区，
内容是同源 iframe 到 `/bilibili-kit`（不重写一套 UI）。离线自测：`node client-smoke.cjs ./client.js`。
如果分区里是空白，说明宿主拦了内嵌页，分区底部有「在新标签打开」的链接兜底。

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 面板显示「无法连接插件 / Unexpected end of JSON input」 | 历史 bug：prefix 路由曾写成 `/bilibili-kit/api/`（带尾斜杠），宿主匹配不到 `/api/status` → 404 空响应。**prefix 的 path 永远不带尾斜杠。** |
| 「登录成功但没拿到合法 SESSDATA」 | 历史 bug：SESSDATA 白名单漏了签名里的 `*`（`%2A`）。现在只拒分号/空白/控制字符，并同时试编码态与解码态、以 nav 的 `isLogin` 为准。仍失败就用面板的「手动粘贴 SESSDATA」。 |
| 「扫码已确认，但响应里没拿到 SESSDATA」 | 历史 bug：登录态在 `Set-Cookie` 响应头里，不是 JSON 的 `data.url`。现在优先读 `getSetCookie()`，再退回「组合 Set-Cookie 头按 `, name=` 切分」，最后才看 `data.url`。 |
| 对话里报 `schema must be a JSON Schema of 'type: "object"'`，且整轮失败 | 历史 bug：工具 `parameters` 写成了扁平属性表。**要么用 defineTool，要么手写 `{type:'object', properties, required, additionalProperties:false}`。** |
| 清单为空、面板提示未登录 | 先在面板扫码登录；登录态会过期，重扫即可 |
| `412 / 403` | 登录态失效或触发风控，重扫二维码 |
| 有字幕清单但没直链 | 字幕被锁定（如仅会员可见），本插件不绕 |
| 面板打不开 | 确认插件已启用；端口用 `$DSH_WEB_URL` 里的值 |
| 局域网其他设备能打开面板 | 登录接口只回环可用（403），但面板页本身随 WebServer 暴露；不需要时把 DSH 的 `networkExposure` 设回 `loopback` |

## 开发约束（改代码前必读，踩过两次）

1. **工具 schema 必须是标准 JSON Schema**：`parameters: { type: 'object', properties: {…}, required: [...], additionalProperties: false }`。
   裸 definition 里的扁平属性表（`{ video: { type: 'string', required: true } }`）不会被 `register()` 拒绝，
   但会把 `type: null` 原样交给模型，**整个会话在调用工具时直接失败**。
   或者改用 `import { defineTool } from '@deepseek-ai/dsh-tools'` 让宿主帮你编译。
2. **prefix 路由的 path 不能带尾斜杠**：宿主匹配规则是
   `pathname === prefix || pathname.startsWith(prefix + '/')`。
   写成 `/bilibili-kit/api/` 会让 `/bilibili-kit/api/status` 404、响应体为空，
   前端 `response.json()` 抛 `Unexpected end of JSON input`。
3. **自测别复刻自己的错误假设**：`smoke.mjs` 曾经自己实现 `startsWith(prefix)` 做路由分发，
   于是把"带尾斜杠 404"这个 bug 一起测过了。测试要照宿主的真实契约写（或直接打真实端口）。
4. **登录态在 `Set-Cookie` 响应头，不在 JSON 里**：扫码 poll 成功时，cookie 由响应头下发；
   `data.url` 只是游戏分站的跨域跳转链接，可能为空。要用 `headers.getSetCookie()`；
   老运行时退回组合头时，**只能在 `, name=` 处切**（`Expires` 和 SESSDATA 值本身都含逗号）。


## 安全边界（实现事实）

- 只保存 `SESSDATA` 一个 cookie，存 `~/.dsh/bilibili-kit/state.json`（目录 0700，Windows 下由 ACL 决定）；
- 面板的 `status` 只回用户名，**永不回显 SESSDATA**；
- `/api/login*` 只接受回环地址请求，防止局域网改登录态；
- 二维码在浏览器本地用 vendored 的 `qrcode-generator` 渲染，不经任何在线二维码服务；
- 不做自动点赞/评论/投币，读到的字幕只用于本地总结。

## 许可

MIT。二维码库：`vendor/qrcode-generator.LICENSE`（MIT © 2009 Kazuhiko Arase）。
