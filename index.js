/**
 * dsh-bilibili-kit — Host 半身（工具 + 本地路由 + 登录态存储）
 *
 * 提供两件事：
 *   1. 给 agent 的两个工具：bilibili_video（标题/简介/分P/字幕清单）、
 *      bilibili_subtitle（字幕正文，可落盘）。
 *   2. 给浏览器的一条面板路由 /bilibili-kit，用于扫码登录、查询、复制字幕。
 *
 * 登录态：只存 SESSDATA（B 站网页登录的会话 cookie）。存在
 * `$DSH_HOME/bilibili-kit/state.json`（权限 0600），不写工作区、不进日志、
 * 不经由聊天传输 —— 扫码后由本插件自己落盘。
 *
 * 不依赖任何 harness 包：工具以裸 definition 注册，路由用 node:http 原始
 * req/res，二维码库作为静态资源从 vendor/ 吐出。
 *
 * @module index.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'bilibili-kit'
export const inject = ['tools', 'webServer']

/** 仅供本地冒烟测试使用；不要在生产代码里依赖它。 */
export const __internals = { validSessdata, sessdataCandidates, splitCombinedSetCookie, sessdataFromSetCookies, extractSessdataInput }

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url))
const ROUTE_PREFIX = '/bilibili-kit'
// 宿主的 prefix 路由按 `${path}/` 匹配：带尾斜杠会让 /bilibili-kit/api/status 永远匹配不上。
const API_PREFIX = '/bilibili-kit/api'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const REFERER = 'https://www.bilibili.com/'
const API = 'https://api.bilibili.com'
const PASSPORT = 'https://passport.bilibili.com'
const FETCH_TIMEOUT_MS = 20_000
const MAX_BODY_BYTES = 64 * 1024

// ---------------------------------------------------------------------------
// 登录态存储
// ---------------------------------------------------------------------------

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  const home = os.homedir()
  return process.platform === 'win32' ? path.join(home, '.dsh') : path.join(home, '.dsh')
}

function stateDir() {
  return path.join(dshHome(), 'bilibili-kit')
}

function statePath() {
  return path.join(stateDir(), 'state.json')
}

/** @returns {{sessdata: string, savedAt: number, mid: number|null, uname: string|null}} */
function readState() {
  try {
    const raw = fs.readFileSync(statePath(), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      sessdata: typeof parsed.sessdata === 'string' ? parsed.sessdata : '',
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      mid: typeof parsed.mid === 'number' ? parsed.mid : null,
      uname: typeof parsed.uname === 'string' ? parsed.uname : null,
    }
  } catch {
    return { sessdata: '', savedAt: 0, mid: null, uname: null }
  }
}

/**
 * SESSDATA 的真实形态是 `<uuid>%2C<expires>%2C<signature>`，签名里常带 `%2A`（解码后是 `*`）。
 * 所以**不做字符白名单**——曾经的白名单把 `*` 判成非法，导致扫码成功却"没拿到合法 SESSDATA"。
 * 这里只拒绝 cookie 注入相关的字符：控制字符、空白、分号。
 */
function validSessdata(value) {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    value.length <= 2048 &&
    !/[\u0000-\u001f\u007f\s;]/u.test(value)
  )
}

/** 回调 URL 里 SESSDATA 的候选形态：编码态（浏览器实发）与解码态各留一份，交给 nav 校验挑。 */
function sessdataCandidates(callbackUrl) {
  const out = []
  const push = (value) => {
    if (typeof value === 'string' && value !== '' && !out.includes(value)) out.push(value)
  }
  const encoded = /[?&]SESSDATA=([^&#]+)/u.exec(callbackUrl)?.[1] ?? ''
  push(encoded)
  try {
    push(decodeURIComponent(encoded))
  } catch {
    /* 非法百分号编码：只保留原样 */
  }
  return out
}

/** 只问"这段 cookie 是否登录"，不碰 wbi（wbi 拿不到不代表没登录）。 */
async function checkLogin(sessdata) {
  const json = await fetchJson(`${API}/x/web-interface/nav`, { sessdata })
  return json?.data?.isLogin === true
}

/**
 * 组合式 Set-Cookie 头（老运行时没有 getSetCookie 时）按 `, <name>=` 切分。
 * 注意：不能简单按逗号切 —— Expires 和 SESSDATA 值里都有逗号。
 */
function splitCombinedSetCookie(combined) {
  if (typeof combined !== 'string' || combined === '') return []
  return combined.split(/,\s*(?=[A-Za-z0-9_]+=)/u).filter((line) => line !== '')
}

/** 从 Set-Cookie 行里取 SESSDATA 的**原始形态**（浏览器实际会发的那种）。 */
function sessdataFromSetCookies(lines) {
  for (const line of lines) {
    const match = /^\s*SESSDATA=([^;]+)/u.exec(line)
    if (match !== null) return match[1]
  }
  return ''
}

/**
 * 手动粘贴的容错：既接受裸 SESSDATA 值，也接受整行 `cookie: a=b; SESSDATA=...; c=d`
 * （DevTools 网络面板里复制请求头那一整行最省事）。
 */
function extractSessdataInput(input) {
  const text = String(input ?? '').trim()
  if (text === '') return ''
  const match = /(?:^|[;\s])SESSDATA=([^;\s]+)/u.exec(text)
  return match !== null ? match[1] : text
}

/**
 * 扫码轮询：必须同时拿 JSON 和响应头。
 * B 站登录成功时是通过 `Set-Cookie` 写登录态的，`data.url` 只是游戏分站跳转链接（可能为空）。
 */
async function pollQr(qrcodeKey) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(
      `${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
      {
        headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json' },
        signal: controller.signal,
      },
    )
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : splitCombinedSetCookie(response.headers.get('set-cookie') ?? '')
    const json = response.ok ? await response.json() : null
    return { json, setCookies }
  } finally {
    clearTimeout(timer)
  }
}

function writeState(next) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
  const payload = JSON.stringify({
    sessdata: next.sessdata,
    savedAt: Date.now(),
    mid: next.mid ?? null,
    uname: next.uname ?? null,
  })
  const tmp = `${statePath()}.tmp`
  fs.writeFileSync(tmp, `${payload}\n`, { mode: 0o600 })
  fs.renameSync(tmp, statePath())
}

function clearState() {
  try {
    fs.rmSync(statePath(), { force: true })
  } catch {
    /* 删不掉就算了：下次运行时 readState 返回空 */
  }
}

// ---------------------------------------------------------------------------
// B 站接口（WBI 签名 + cookie）
// ---------------------------------------------------------------------------

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6,
  63, 57, 62, 11, 36, 20, 34, 44, 52,
]

async function fetchJson(url, { sessdata = '', timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json' }
    if (sessdata !== '') headers.Cookie = `SESSDATA=${sessdata}`
    const response = await fetch(url, { headers, signal: controller.signal })
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status} ${response.statusText}`)
      error.status = response.status
      throw error
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 带登录态调用失败时，把 B 站的风控状态翻译成人话；412/403 基本等于登录态过期。 */
function explainAuthFailure(error) {
  const status = error?.status
  if (status === 412 || status === 403) {
    return '登录态可能已失效（B 站返回 412/403）。请在面板里重新扫码登录。'
  }
  return null
}

async function wbiKeys(sessdata) {
  const json = await fetchJson(`${API}/x/web-interface/nav`, { sessdata })
  const imgUrl = json?.data?.wbi_img?.img_url
  const subUrl = json?.data?.wbi_img?.sub_url
  if (typeof imgUrl !== 'string' || typeof subUrl !== 'string') {
    throw new Error('B 站 wbi 密钥不可用（导航接口未返回 wbi_img）')
  }
  const pick = (u) => u.slice(u.lastIndexOf('/') + 1).split('.')[0]
  const raw = pick(imgUrl) + pick(subUrl)
  const key = Array.from(MIXIN_KEY_ENC_TAB, (i) => raw[i] ?? '').join('').slice(0, 32)
  return { key, isLogin: json?.data?.isLogin === true }
}

function signWbi(params, key) {
  const wts = Math.floor(Date.now() / 1000)
  const all = { ...params, wts: String(wts) }
  const query = Object.keys(all)
    .sort()
    .map((k) => {
      const value = String(all[k]).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
      return `${encodeURIComponent(k)}=${encodeURIComponent(value)}`
    })
    .join('&')
  const wRid = crypto.createHash('md5').update(query + key).digest('hex')
  return `${query}&w_rid=${wRid}`
}

/** 把各种输入收敛成 {bvid?, aid?}。 */
function parseVideoId(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') throw new Error('缺少视频标识（BV 号 / av 号 / 链接）')
  const bv = /BV[0-9A-Za-z]{10}/u.exec(text)
  if (bv !== null) return { bvid: bv[0] }
  const av = /(?:^|[^0-9])av(\d{1,12})(?:[^0-9]|$)/iu.exec(text)
  if (av !== null) return { aid: Number(av[1]) }
  const short = /b23\.tv\/([0-9A-Za-z]+)/u.exec(text)
  if (short !== null) return { shortCode: short[1] }
  if (/^\d+$/u.test(text)) return { aid: Number(text) }
  throw new Error('认不出视频标识：请给 BV 号（如 BV1xx411c7mD）、av 号或完整链接')
}

async function resolveShortLink(code) {
  const response = await fetch(`https://b23.tv/${code}`, {
    headers: { 'User-Agent': UA, Referer: REFERER },
    redirect: 'manual',
  })
  const location = response.headers.get('location') ?? ''
  const match = /BV[0-9A-Za-z]{10}/u.exec(location)
  if (match === null) throw new Error(`短链 ${code} 没有解析出 BV 号（B 站可能改版了）`)
  return { bvid: match[0] }
}

async function fetchView(id) {
  let query
  if (id.bvid !== undefined) query = `bvid=${id.bvid}`
  else if (id.aid !== undefined) query = `aid=${id.aid}`
  else if (id.shortCode !== undefined) {
    const resolved = await resolveShortLink(id.shortCode)
    query = `bvid=${resolved.bvid}`
  } else throw new Error('缺少视频标识')
  const json = await fetchJson(`${API}/x/web-interface/view?${query}`)
  if (json?.code !== 0 || json?.data === undefined) {
    throw new Error(`视频信息接口返回 code=${json?.code ?? '?'}：${json?.message ?? '未知错误'}`)
  }
  return json.data
}

/** 用 player/wbi/v2 取字幕清单；未登录时 B 站返回空数组（这是预期行为，不是错误）。 */
async function fetchSubtitles(data, sessdata) {
  const { key } = await wbiKeys(sessdata)
  const signed = signWbi({ aid: data.aid, cid: data.cid, bvid: data.bvid }, key)
  const json = await fetchJson(`${API}/x/player/wbi/v2?${signed}`, { sessdata })
  const subtitle = json?.data?.subtitle ?? {}
  const list = Array.isArray(subtitle.subtitles) ? subtitle.subtitles : []
  return {
    needLogin: subtitle.need_login_subtitle === true,
    allowSubmit: subtitle.allow_submit === true,
    list: list
      .map((entry) => ({
        lan: typeof entry.lan === 'string' ? entry.lan : '',
        lanDoc: typeof entry.lan_doc === 'string' ? entry.lan_doc : '',
        url: typeof entry.subtitle_url === 'string' ? entry.subtitle_url : '',
        isAi: entry.ai_type === 1,
      }))
      .filter((entry) => entry.lan !== ''),
  }
}

/**
 * 字幕清单的"安全版"：拿到视频信息（含简介）不应该被字幕接口的登录态问题连坐。
 * 失败时返回 { list: [], failure }，由调用方决定展示成"没有字幕"还是报错。
 */
async function tryFetchSubtitles(data, sessdata) {
  try {
    return { ...(await fetchSubtitles(data, sessdata)), failure: null }
  } catch (error) {
    return { needLogin: false, allowSubmit: false, list: [], failure: explainAuthFailure(error) ?? String(error?.message ?? error) }
  }
}

async function fetchSubtitleBody(url) {
  const absolute = url.startsWith('//') ? `https:${url}` : url
  const json = await fetchJson(absolute)
  const body = Array.isArray(json?.body) ? json.body : []
  const lines = body.map((line) => ({
    from: typeof line.from === 'number' ? line.from : 0,
    to: typeof line.to === 'number' ? line.to : 0,
    text: typeof line.content === 'string' ? line.content.trim() : '',
  }))
  return lines.filter((line) => line.text !== '')
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function pickPage(data, page) {
  const pages = Array.isArray(data.pages) ? data.pages : []
  if (pages.length === 0) return { cid: data.cid, pageNumber: 1, title: data.title, pages }
  const index = Number.isInteger(page) && page >= 1 && page <= pages.length ? page - 1 : 0
  const selected = pages[index]
  return {
    cid: selected.cid,
    pageNumber: index + 1,
    title: pages.length > 1 ? `${data.title} · P${index + 1} ${selected.part ?? ''}`.trim() : data.title,
    pages,
  }
}

function makeVideoTool() {
  return {
    name: 'bilibili_video',
    description:
      '读取一个 B 站视频的元信息：标题、简介、UP 主、时长、分P 列表，以及**字幕清单**（语种/是否 AI 字幕）。登录态由本机 bilibili-kit 插件保存（扫码登录，不需要用户提供 cookie）；未登录时字幕清单为空。先用这个工具确认"视频里能不能拿到文字"，再用 bilibili_subtitle 取字幕正文。',
    // 裸 definition 不会经过 defineTool 编译，parameters 必须直接是 JSON Schema；
    // 写成扁平的属性表会变成 type:null，模型侧会整轮拒绝。
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        video: {
          type: 'string',
          description: 'BV 号（如 BV1xx411c7mD）、av 号，或 bilibili.com / b23.tv 链接。',
        },
        page: {
          type: 'number',
          description: '分P 序号，从 1 开始；默认 1。',
        },
        include_description: {
          type: 'boolean',
          description: '是否返回视频简介全文，默认 true。简介很长时可设 false 省上下文。',
        },
      },
      required: ['video'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const id = parseVideoId(args.video)
      const data = await fetchView(id)
      const sessdata = readState().sessdata
      const { cid, pageNumber, title, pages } = pickPage(data, args.page)
      const withCid = { ...data, cid }
      const subtitleReport = await tryFetchSubtitles(withCid, sessdata)
      const includeDesc = args.include_description !== false
      const desc = typeof data.desc === 'string' ? data.desc.trim() : ''

      const lines = [
        `# ${title}`,
        '',
        `- BV 号：${data.bvid ?? '(未知)'}　aid：${data.aid ?? '(未知)'}　cid：${cid}`,
        `- UP 主：${data.owner?.name ?? '(未知)'}（mid ${data.owner?.mid ?? '?'}）`,
        `- 发布：${data.pubdate ? new Date(data.pubdate * 1000).toLocaleString('zh-CN', { hour12: false }) : '(未知)'}`,
        `- 时长：${formatTimestamp(typeof data.duration === 'number' ? data.duration : 0)}`,
        `- 播放 ${data.stat?.view ?? '?'}　弹幕 ${data.stat?.danmaku ?? '?'}　点赞 ${data.stat?.like ?? '?'}　收藏 ${data.stat?.favorite ?? '?'}`,
        `- 登录态：${sessdata !== '' ? '已保存 SESSDATA' : '未登录'}（字幕清单${sessdata !== '' ? '' : '为空是预期结果'}）`,
      ]
      if (pages.length > 1) {
        lines.push(`- 分P：共 ${pages.length} 个，当前第 ${pageNumber} 个`)
        lines.push(
          ...pages.map((p, i) => `  - P${i + 1} cid=${p.cid} ${String(p.part ?? '').slice(0, 60)}`),
        )
      }
      if (subtitleReport.list.length === 0) {
        if (subtitleReport.failure) {
          lines.push(`- 字幕：⚠ ${subtitleReport.failure}`)
        } else {
          lines.push('- 字幕：**没有可用字幕**（未登录或该视频未上传字幕）。可改用抽帧截图 + 音频转写。')
        }
      } else {
        lines.push(`- 字幕：${subtitleReport.list.length} 条`)
        for (const entry of subtitleReport.list) {
          lines.push(`  - ${entry.lan}（${entry.lanDoc}）${entry.isAi ? ' AI 生成' : ' 人工'}${entry.url === '' ? ' ⚠ 无直链' : ''}`)
        }
      }
      lines.push('')
      lines.push('## 简介')
      if (!includeDesc) lines.push('（已省略，需全文请把 include_description 设为 true）')
      else if (desc === '') lines.push('（简介为空）')
      else lines.push(desc.length > 4000 ? `${desc.slice(0, 4000)}\n…（简介过长，已截断）` : desc)
      return lines.join('\n')
    },
  }
}

function makeSubtitleTool() {
  return {
    name: 'bilibili_subtitle',
    description:
      '读取 B 站视频的字幕正文（需要本机 bilibili-kit 插件里已保存登录态）。返回带时间戳的全文；可用 language 指定语种（如 zh-CN、ai-zh），不给则优先中文、其次第一条。可选 save_to 把纯文本落盘（绝对路径，建议放在当前任务资料夹内）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        video: {
          type: 'string',
          description: 'BV 号、av 号或 bilibili.com / b23.tv 链接。',
        },
        page: { type: 'number', description: '分P 序号，从 1 开始；默认 1。' },
        language: { type: 'string', description: '语种代码，如 zh-CN / ai-zh；省略时自动选中文。' },
        save_to: { type: 'string', description: '可选：把字幕纯文本写入这个绝对路径（会覆盖同名文件）。' },
        limit: {
          type: 'number',
          description: '最多返回多少行（防止超长视频撑爆上下文），默认 400，上限 2000。',
        },
      },
      required: ['video'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const state = readState()
      if (state.sessdata === '') {
        return '错误：本机还没有 B 站登录态。请在插件面板（侧栏打开 http://127.0.0.1:<端口>/bilibili-kit）扫码登录，或让用户从 B 站网页取 SESSDATA 后保存。'
      }
      const id = parseVideoId(args.video)
      const data = await fetchView(id)
      const { cid, pageNumber } = pickPage(data, args.page)
      const report = await tryFetchSubtitles({ ...data, cid }, state.sessdata)
      if (report.list.length === 0) {
        if (report.failure) return `错误：${report.failure}`
        return `该视频（P${pageNumber}）没有可用字幕：可能未上传字幕、字幕仅会员可见，或登录态已失效。可改用 bilibili_video 看简介，或抽帧截图。`
      }
      const wanted = typeof args.language === 'string' && args.language !== ''
        ? report.list.find((e) => e.lan.toLowerCase() === args.language.toLowerCase())
        : report.list.find((e) => e.lan === 'zh-CN') ?? report.list.find((e) => e.lan.startsWith('ai-')) ?? report.list[0]
      if (wanted === undefined) {
        return `没有语种 ${args.language} 的字幕。可选：${report.list.map((e) => e.lan).join(', ')}`
      }
      if (wanted.url === '') return `字幕清单里有 ${wanted.lan}，但没有直链（可能登录态失效或字幕被锁定）。`
      const lines = await fetchSubtitleBody(wanted.url)
      if (lines.length === 0) return `字幕 ${wanted.lan} 内容为空。`
      const limit = Math.min(Math.max(Number(args.limit) || 400, 20), 2000)
      const shown = lines.slice(0, limit)
      const plainText = lines.map((l) => l.text).join('\n')

      let savedNote = ''
      if (typeof args.save_to === 'string' && args.save_to.trim() !== '') {
        const target = path.resolve(args.save_to.trim())
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, `${plainText}\n`, 'utf8')
        savedNote = `\n\n（已保存纯文本到 ${target}，共 ${lines.length} 行）`
      }

      const header = `# 字幕 · ${data.title} · P${pageNumber} · ${wanted.lan}${wanted.isAi ? '（AI 生成）' : ''}`
      const body = shown.map((l) => `[${formatTimestamp(l.from)}] ${l.text}`).join('\n')
      const truncated = lines.length > limit ? `\n\n…（共 ${lines.length} 行，已显示前 ${limit} 行；可提高 limit 或直接用 save_to 落盘读全文）` : ''
      return `${header}\n\n${body}${truncated}${savedNote}`
    },
  }
}

// ---------------------------------------------------------------------------
// HTTP 路由（面板 + JSON API）
// ---------------------------------------------------------------------------

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function sendText(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    const error = new Error('请求体不是合法 JSON')
    error.code = 'BAD_BODY'
    throw error
  }
}

/** 只接受本机回环请求：桌面端 WebServer 可能监听 0.0.0.0，不能让局域网改登录态。 */
function isLoopbackRequest(req) {
  const address = req.socket?.remoteAddress ?? ''
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback) return false
  const host = String(req.headers.host ?? '')
  const hostname = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0]
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === ''
}

function safePanelHtml() {
  const htmlPath = path.join(PKG_DIR, 'panel.html')
  return fs.readFileSync(htmlPath, 'utf8')
}

async function loginStatus() {
  const state = readState()
  if (state.sessdata === '') {
    return { loggedIn: false, uname: null, mid: null, savedAt: 0 }
  }
  try {
    const nav = await fetchJson(`${API}/x/web-interface/nav`, { sessdata: state.sessdata })
    if (nav?.data?.isLogin !== true) {
      return { loggedIn: false, uname: null, mid: null, savedAt: state.savedAt, stale: true }
    }
    return {
      loggedIn: true,
      uname: typeof nav?.data?.uname === 'string' ? nav.data.uname : state.uname,
      mid: typeof nav?.data?.mid === 'number' ? nav.data.mid : state.mid,
      savedAt: state.savedAt,
    }
  } catch (error) {
    return { loggedIn: false, uname: null, mid: null, savedAt: state.savedAt, error: String(error?.message ?? error) }
  }
}

async function handleApi(req, res, url) {
  const route = url.pathname.slice(API_PREFIX.length).replace(/^\/+/u, '')

  if (!isLoopbackRequest(req) && route.startsWith('login')) {
    return sendJson(res, 403, { error: '登录相关接口只接受本机回环访问' })
  }

  if (route === 'status' && req.method === 'GET') {
    return sendJson(res, 200, await loginStatus())
  }

  if (route === 'login/generate' && req.method === 'POST') {
    const json = await fetchJson(`${PASSPORT}/x/passport-login/web/qrcode/generate`)
    if (json?.code !== 0 || typeof json?.data?.qrcode_key !== 'string') {
      return sendJson(res, 502, { error: `二维码接口失败：${json?.message ?? '未知'}` })
    }
    return sendJson(res, 200, { qrcode_key: json.data.qrcode_key, url: json.data.url })
  }

  if (route === 'login/poll' && req.method === 'GET') {
    const key = url.searchParams.get('qrcode_key') ?? ''
    if (!/^[0-9a-zA-Z]{8,64}$/u.test(key)) return sendJson(res, 400, { error: 'qrcode_key 非法' })
    const { json, setCookies } = await pollQr(key)
    const data = json?.data ?? {}
    const code = typeof data.code === 'number' ? data.code : -1
    if (code === 0) {
      // 成功：登录态在 Set-Cookie 响应头里（这才是主要来源），data.url 仅作补充
      const callback = typeof data.url === 'string' ? data.url : ''
      const candidates = [
        sessdataFromSetCookies(setCookies),
        ...sessdataCandidates(callback),
      ].filter(validSessdata)
      const unique = [...new Set(candidates)]
      if (unique.length === 0) {
        return sendJson(res, 502, {
          error: `扫码已确认，但响应里没拿到 SESSDATA（Set-Cookie ${setCookies.length} 条，回调 ${callback === '' ? '为空' : '无该参数'}）。请用面板的「手动粘贴 SESSDATA」兜底。`,
          needManual: true,
        })
      }
      let accepted = ''
      let lastError = ''
      for (const candidate of unique) {
        try {
          if (await checkLogin(candidate)) {
            accepted = candidate
            break
          }
          lastError = 'nav 返回未登录'
        } catch (error) {
          lastError = String(error?.message ?? error)
        }
      }
      if (accepted === '') {
        return sendJson(res, 502, {
          error: `扫码已确认，但登录态校验没过（${lastError}）。可稍后重试，或用面板的「手动粘贴 SESSDATA」。`,
          needManual: true,
        })
      }
      writeState({ sessdata: accepted })
      const status = await loginStatus()
      return sendJson(res, 200, { state: 'success', ...status })
    }
    const state = code === 86101 ? 'waiting' : code === 86090 ? 'scanned' : code === 86100 ? 'expired' : 'unknown'
    return sendJson(res, 200, {
      state,
      code,
      message: typeof data.message === 'string' ? data.message : '',
    })
  }

  if (route === 'login/manual' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const value = extractSessdataInput(body?.sessdata)
    if (!validSessdata(value)) {
      return sendJson(res, 400, { error: 'SESSDATA 形态不对：不能含空格/分号/换行，长度 8–2048。' })
    }
    let isLogin = false
    try {
      isLogin = await checkLogin(value)
    } catch (error) {
      return sendJson(res, 502, { error: `校验请求失败：${String(error?.message ?? error)}` })
    }
    if (!isLogin) return sendJson(res, 401, { error: '这段 SESSDATA 已失效或不是登录态，请重新获取' })
    writeState({ sessdata: value })
    const status = await loginStatus()
    return sendJson(res, 200, { state: 'success', ...status })
  }

  if (route === 'logout' && req.method === 'POST') {
    clearState()
    return sendJson(res, 200, { ok: true })
  }

  if (route === 'video' && req.method === 'GET') {
    const video = url.searchParams.get('video') ?? ''
    const page = Number(url.searchParams.get('page') ?? '1')
    const data = await fetchView(parseVideoId(video))
    const { cid, pageNumber, title, pages } = pickPage(data, page)
    const state = readState()
    const report = await tryFetchSubtitles({ ...data, cid }, state.sessdata)
    return sendJson(res, 200, {
      bvid: data.bvid ?? null,
      aid: data.aid ?? null,
      cid,
      title,
      pageNumber,
      pageCount: pages.length,
      pages: pages.map((p, i) => ({ page: i + 1, cid: p.cid, part: String(p.part ?? '') })),
      owner: data.owner?.name ?? null,
      duration: typeof data.duration === 'number' ? data.duration : 0,
      pubdate: typeof data.pubdate === 'number' ? data.pubdate : 0,
      desc: typeof data.desc === 'string' ? data.desc : '',
      stat: data.stat ?? {},
      subtitles: report.list,
      subtitleError: report.failure,
      loggedIn: state.sessdata !== '',
    })
  }

  if (route === 'subtitle' && req.method === 'GET') {
    const state = readState()
    if (state.sessdata === '') return sendJson(res, 401, { error: '未登录：请先在面板扫码登录' })
    const video = url.searchParams.get('video') ?? ''
    const page = Number(url.searchParams.get('page') ?? '1')
    const language = url.searchParams.get('language') ?? ''
    const data = await fetchView(parseVideoId(video))
    const { cid } = pickPage(data, page)
    const report = await tryFetchSubtitles({ ...data, cid }, state.sessdata)
    if (report.failure) return sendJson(res, 401, { error: report.failure })
    if (report.list.length === 0) return sendJson(res, 404, { error: '该视频没有可用字幕' })
    const wanted =
      (language !== '' && report.list.find((e) => e.lan.toLowerCase() === language.toLowerCase())) ||
      report.list.find((e) => e.lan === 'zh-CN') ||
      report.list.find((e) => e.lan.startsWith('ai-')) ||
      report.list[0]
    if (wanted === undefined || wanted.url === '') return sendJson(res, 404, { error: '字幕没有直链' })
    const lines = await fetchSubtitleBody(wanted.url)
    return sendJson(res, 200, {
      lan: wanted.lan,
      lanDoc: wanted.lanDoc,
      isAi: wanted.isAi,
      lines,
      text: lines.map((l) => l.text).join('\n'),
    })
  }

  if (route === 'vendor/qrcode.js' && req.method === 'GET') {
    const file = path.join(PKG_DIR, 'vendor', 'qrcode.js')
    return sendText(res, 200, 'text/javascript; charset=utf-8', fs.readFileSync(file, 'utf8'))
  }

  return sendJson(res, 404, { error: `未知接口：${route}` })
}

function registerRoutes(ctx) {
  const disposers = []

  disposers.push(
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendText(res, 405, 'text/plain; charset=utf-8', 'method not allowed')
        try {
          return sendText(res, 200, 'text/html; charset=utf-8', safePanelHtml())
        } catch (error) {
          return sendText(res, 500, 'text/plain; charset=utf-8', `panel.html 读取失败：${String(error)}`)
        }
      },
    }),
  )

  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        try {
          return await handleApi(req, res, url)
        } catch (error) {
          const status = error?.code === 'BAD_BODY' ? 400 : 500
          return sendJson(res, status, { error: String(error?.message ?? error) })
        }
      },
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}

export function apply(ctx) {
  const logger = ctx.logger ?? console
  const toolDisposers = [makeVideoTool(), makeSubtitleTool()].map((tool) => ctx.tools.register(tool))
  const disposeRoutes = registerRoutes(ctx)
  ctx.effect(() => () => {
    for (const dispose of toolDisposers) dispose()
    disposeRoutes()
  }, 'dsh-bilibili-kit: tools + routes')
  logger.info?.(`[bilibili-kit] ready · panel ${ROUTE_PREFIX} · state ${statePath()}`)
}
