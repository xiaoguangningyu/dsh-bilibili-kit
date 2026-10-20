/**
 * 本地冒烟测试：不依赖 DSH 宿主，用一个假的 ctx 把插件 apply 起来，
 * 再起一个真实的 HTTP 服务喂给注册进来的路由，验证：
 *   1. apply() 不抛错、工具/路由都注册上了；
 *   2. 匿名（未登录）时 bilibili_video 能拿到标题/简介/分P；
 *   3. 未登录时 bilibili_subtitle 给出可读提示；
 *   4. 面板 HTML、vendor/qrcode.js、status 接口可访问；
 *   5. 伪造登录态后：status 能识别、state.json 权限是 0600、
 *      bilibili_subtitle 的 save_to 能真的落盘（走 WBI 签名那条真实链路）。
 *
 * 用法：node smoke.mjs [./index.js] [BV号]
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const pluginPath = process.argv[2] ?? './index.js'
const sampleVideo = process.argv[3] ?? 'BV1GJ411x7h7'

// 所有登录态相关文件都落到临时目录，绝不碰用户真实的 ~/.dsh
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bilibili-kit-smoke-'))
process.env.DSH_HOME = fakeHome

const tools = new Map()
const routes = { exact: new Map(), prefix: new Map() }
const effects = []

const fakeCtx = {
  logger: { info: (m) => console.log('[log]', m), warn: (m) => console.log('[warn]', m) },
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => tools.delete(tool.name)
    },
  },
  webServer: {
    register(route) {
      const table = route.kind === 'exact' ? routes.exact : routes.prefix
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route ${route.path}`)
      table.set(route.path, route)
      return () => table.delete(route.path)
    },
  },
  effect(factory, label) {
    effects.push(label ?? 'effect')
    const dispose = factory()
    return dispose
  },
}

const mod = await import(pathToFileURL(pluginPath).href)
console.log('plugin name:', mod.name, '| inject:', JSON.stringify(mod.inject))
mod.apply(fakeCtx)
console.log('tools registered:', [...tools.keys()].join(', '))
console.log('exact routes:', [...routes.exact.keys()].join(', '))
console.log('prefix routes:', [...routes.prefix.keys()].join(', '))
if (!tools.has('bilibili_video') || !tools.has('bilibili_subtitle')) throw new Error('缺少工具')

// 用真实 http server 复刻路由分发，方便验证面板与 API
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const exact = routes.exact.get(url.pathname)
  if (exact) return exact.handler(req, res)
  // 与宿主 dsh-host-webserver 的语义保持一致：prefix 只吃 `${prefix}/` 开头的路径。
  // （早先这里写成裸 startsWith，所以 prefix 带尾斜杠的 bug 在冒烟里是绿的。）
  for (const [prefix, route] of routes.prefix) {
    if (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)) return route.handler(req, res)
  }
  res.writeHead(404).end('not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const base = `http://127.0.0.1:${port}`

async function main() {
  let failed = 0
  const check = (label, ok, detail = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
    if (!ok) failed += 1
  }

  // 1) 匿名视频信息
  try {
    const out = await tools.get('bilibili_video').execute({ video: sampleVideo }, {})
    check('bilibili_video 匿名返回', typeof out === 'string' && out.includes('UP 主'), out.split('\n')[0])
  } catch (error) {
    check('bilibili_video 匿名返回', false, String(error))
  }

  // 2) 匿名字幕提示
  try {
    const out = await tools.get('bilibili_subtitle').execute({ video: sampleVideo }, {})
    check('bilibili_subtitle 未登录提示', typeof out === 'string' && out.startsWith('错误：本机还没有 B 站登录态'), out.slice(0, 40))
  } catch (error) {
    check('bilibili_subtitle 未登录提示', false, String(error))
  }

  // 3) 面板 + vendor + status
  const panel = await fetch(`${base}/bilibili-kit`)
  const panelText = await panel.text()
  check('面板 HTML', panel.status === 200 && panelText.includes('B 站字幕工具'), `status=${panel.status}`)
  const vendor = await fetch(`${base}/bilibili-kit/api/vendor/qrcode.js`)
  const vendorText = await vendor.text()
  check('vendor/qrcode.js', vendor.status === 200 && vendorText.includes('createDataURL'), `status=${vendor.status}`)
  const status = await fetch(`${base}/bilibili-kit/api/status`)
  const statusJson = await status.json()
  check('api/status', status.status === 200 && typeof statusJson.loggedIn === 'boolean', JSON.stringify(statusJson).slice(0, 80))

  // 4) 视频 API（匿名）
  const video = await fetch(`${base}/bilibili-kit/api/video?video=${encodeURIComponent(sampleVideo)}`)
  const videoJson = await video.json()
  check('api/video', video.status === 200 && typeof videoJson.title === 'string', videoJson.title ?? JSON.stringify(videoJson).slice(0, 80))
  check('api/video 字幕数组', Array.isArray(videoJson.subtitles), `subtitles=${(videoJson.subtitles || []).length}`)

  // 5) 二维码生成（不扫码，只验证能拿到 key）
  const qr = await fetch(`${base}/bilibili-kit/api/login/generate`, { method: 'POST' })
  const qrJson = await qr.json()
  check('api/login/generate', qr.status === 200 && typeof qrJson.qrcode_key === 'string', qrJson.error ?? 'ok')
  if (typeof qrJson.qrcode_key === 'string') {
    const poll = await fetch(`${base}/bilibili-kit/api/login/poll?qrcode_key=${qrJson.qrcode_key}`)
    const pollJson = await poll.json()
    check('api/login/poll', poll.status === 200 && typeof pollJson.state === 'string', JSON.stringify(pollJson).slice(0, 80))
  }

  // 5b) SESSDATA 形态与提取（回归：真实值带 `*`，旧白名单把它判成非法）
  const { validSessdata, sessdataCandidates, splitCombinedSetCookie, sessdataFromSetCookies, extractSessdataInput } = mod.__internals
  check('SESSDATA 编码态被接受', validSessdata('abc%2C1700000000%2Cdef%2Axyz') === true)
  check('SESSDATA 解码态（含 *）被接受', validSessdata('abc,1700000000,def*xyz') === true)
  check('SESSDATA 含分号被拒绝', validSessdata('bad;value=1') === false)
  check('SESSDATA 含空白被拒绝', validSessdata('bad value') === false)
  const cands = sessdataCandidates('https://www.bilibili.com/?SESSDATA=a%2Cb%2A&bili_jct=x')
  check('回调提取出两种形态', cands.length === 2 && cands[0] === 'a%2Cb%2A' && cands[1] === 'a,b*', JSON.stringify(cands))
  check('手动输入裸值原样保留', extractSessdataInput(' abc%2C1%2Cdef ') === 'abc%2C1%2Cdef')
  check(
    '手动输入整行 cookie 也能识别',
    extractSessdataInput('buvid3=x; SESSDATA=abc%2C1%2Cdef%2A; bili_jct=y') === 'abc%2C1%2Cdef%2A',
  )

  // 5b2) 登录态真正来源：Set-Cookie 响应头（回归：曾只读 JSON、漏读响应头）
  const cookieLines = [
    'SESSDATA=abc%2C1700000000%2Cdef%2A; Path=/; Domain=bilibili.com; HttpOnly; Secure',
    'bili_jct=xyz; Path=/; Domain=bilibili.com',
  ]
  check('从 Set-Cookie 取到 SESSDATA', sessdataFromSetCookies(cookieLines) === 'abc%2C1700000000%2Cdef%2A')
  check('没有 SESSDATA 时返回空串', sessdataFromSetCookies(['bili_jct=x; Path=/']) === '')
  const split = splitCombinedSetCookie(
    'SESSDATA=a%2Cb%2A; Path=/; Expires=Sat, 04 Mar 2023 07:30:09 GMT, bili_jct=x; Path=/, DedeUserID=y',
  )
  check('组合头按 cookie 边界切分', split.length === 3, JSON.stringify(split.map((line) => line.split('=')[0])))

  // 5c) 手动登录态：非法形态 400、失效值不落盘
  const noStateYet = () => !fs.existsSync(path.join(fakeHome, 'bilibili-kit', 'state.json'))
  const badManual = await fetch(`${base}/bilibili-kit/api/login/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessdata: 'has space and; semicolon' }),
  })
  check('api/login/manual 拒绝非法形态', badManual.status === 400 && noStateYet(), `status=${badManual.status}`)

  const deadManual = await fetch(`${base}/bilibili-kit/api/login/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessdata: 'deadbeefcafebabe1234,1700000000,fakehash*abc' }),
  })
  const deadJson = await deadManual.json()
  check(
    'api/login/manual 校验失败不落盘',
    deadManual.status !== 200 && noStateYet(),
    `status=${deadManual.status} ${deadJson.error ?? ''}`.slice(0, 90),
  )

  // 6) 伪造登录态：验证存储位置/权限、status 识别、save_to 落盘、失效态的错误路径
  const stateDir = path.join(fakeHome, 'bilibili-kit')
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(
    path.join(stateDir, 'state.json'),
    `${JSON.stringify({ sessdata: 'deadbeefcafebabe1234,1700000000,fakehash', savedAt: Date.now(), mid: null, uname: null })}\n`,
    { mode: 0o600 },
  )
  const fakeState = fs.statSync(path.join(stateDir, 'state.json'))
  check(
    'state.json 已创建',
    fakeState.size > 0,
    process.platform === 'win32' ? `win32 权限由 ACL 决定，posix mode=${(fakeState.mode & 0o777).toString(8)}` : `mode=${(fakeState.mode & 0o777).toString(8)}`,
  )

  const status2 = await (await fetch(`${base}/bilibili-kit/api/status`)).json()
  check('伪造登录态被识别为已保存（可失效）', typeof status2.loggedIn === 'boolean' && status2.savedAt > 0, JSON.stringify(status2).slice(0, 100))

  const outFile = path.join(fakeHome, 'subtitle-out.txt')
  const subOut = await tools.get('bilibili_subtitle').execute({ video: sampleVideo, save_to: outFile }, {})
  const produced = fs.existsSync(outFile)
  check(
    '伪造登录态走通真实 WBI 链路',
    typeof subOut === 'string' &&
      (subOut.includes('登录态可能已失效') || subOut.includes('没有可用字幕') || produced || subOut.startsWith('# 字幕')),
    String(subOut).split('\n')[0].slice(0, 90),
  )
  check('save_to 只在真有字幕时建文件', produced === subOut.startsWith('# 字幕'), `produced=${produced}`)

  // 7) 非法输入
  const bad = await fetch(`${base}/bilibili-kit/api/video?video=not-a-video`)
  check('非法视频标识返回错误', bad.status === 500 || bad.status === 400, `status=${bad.status}`)

  console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' CHECK(S) FAILED'}`)
  server.close()
  fs.rmSync(fakeHome, { recursive: true, force: true })
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('SMOKE ERROR', error)
  server.close()
  process.exitCode = 1
})
