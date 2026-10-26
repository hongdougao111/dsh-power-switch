/**
 * dsh-power-switch · Host 半边
 *
 * 把「重启」「关闭」翻译成真正的进程生命周期操作。
 *
 * ── 关键洞察（决定整个实现）──────────────────────────────────────
 * Desktop 里宿主是 Electron 主进程的子进程。主进程监视宿主退出，
 * 无论退出码是 0 还是 1 都会调 fail() 弹恢复框——插件在 host 里改不了这个行为。
 *
 * 所以正确的做法是：**结束 Electron 主进程，而不是宿主**。
 *   taskkill /PID <mainPid> /F   （不带 /T）
 * 主进程没了 → 没人能弹窗；宿主的 IPC 通道随之断开 → 宿主自己执行优雅关闭，
 * 会话日志正常落盘；helper 等端口释放后再拉起新实例。
 *
 * ── 两条路径 ────────────────────────────────────────────────────
 * - 关闭：结束主进程，宿主随 IPC 断开自行退出，不拉起替代进程。
 * - 重启：同上，然后等端口释放、清理环境变量、重放同一个可执行文件。
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-power-switch'
export const inject = ['webServer']

/** 从 package.json 读版本，读不到就报 unknown —— 宁可说谎说不知道，也不假装。 */
const PLUGIN_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = readFileSync(join(here, 'package.json'), 'utf8')
    return String(JSON.parse(raw).version ?? 'unknown')
  } catch {
    return 'unknown'
  }
})()
/** 每次改代码手动改这行，用来确认实际加载的到底是哪一份。 */
const BUILD_TAG = 'reap-stale-2026-10-26'

const ROUTE = '/dsh-power-switch/api'
/** 发完 HTTP 响应到动手之间的缓冲，让响应先落地。 */
const EXIT_DELAY_MS = 400
/** 单份 helper 日志上限，超了就轮转，免得临时目录堆一堆大文件。 */
const LOG_MAX_BYTES = 1024 * 1024
/** 新实例启动后必须真的出现窗口，才算活；只看进程会误判。 */
const WINDOW_WAIT_MS = 30_000

/** 本进程（宿主）的现场事实。 */
function runtimeFacts() {
  return {
    pid: process.pid,
    ppid: process.ppid,
    platform: process.platform,
    execPath: process.execPath,
    electron: Boolean(process.versions && process.versions.electron),
    argv: process.argv.slice(0, 8),
  }
}

/**
 * 找到 Electron 主进程：宿主进程的父进程。
 *
 * 在 Desktop 下，宿主是主进程 fork 出来的，ppid 就是主进程。
 * 普通 node 启动的 dsh web 没有这层，返回 null（此时不适用主进程方案）。
 */
function mainProcessOf(facts) {
  if (facts.electron !== true) return null
  const ppid = facts.ppid
  if (!Number.isInteger(ppid) || ppid <= 1) return null
  return ppid
}

function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * helper 源码：在宿主之外独立运行（detached），负责收尾与重放。
 *
 * 传进来的都是纯数据，helper 不依赖任何插件模块。
 */
function helperSource(payload) {
  return [
    "const { execFileSync, spawn } = require('node:child_process')",
    "const fs = require('node:fs')",
    "const net = require('node:net')",
    `const p = ${JSON.stringify(payload)}`,
    'const sleep = (ms) => new Promise((r) => setTimeout(r, ms))',
    'const LOG_MAX = p.logMaxBytes || 1048576',
    'const note = (line) => {',
    '  try {',
    '    const text = `[dsh-power-switch] ${line}\\n`',
    '    try {',
    '      const st = fs.statSync(p.logErr)',
    '      if (st.size > LOG_MAX) fs.renameSync(p.logErr, `${p.logErr}.1`)',
    '    } catch {}',
    '    fs.appendFileSync(p.logErr, text)',
    '  } catch {}',
    '}',
    'const alive = (pid) => {',
    '  if (!Number.isInteger(pid) || pid <= 1) return false',
    '  try { process.kill(pid, 0); return true } catch { return false }',
    '}',
    'const killPid = (pid) => {',
    '  try { execFileSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true }); return true }',
    '  catch { return false }',
    '}',
    'const listening = (port) => new Promise((done) => {',
    '  if (!port) { done(false); return }',
    '  const s = net.connect({ host: "127.0.0.1", port })',
    '  let settled = false',
    '  const finish = (v) => { if (settled) return; settled = true; try { s.destroy() } catch {} done(v) }',
    '  s.on("connect", () => finish(true))',
    '  s.on("error", () => finish(false))',
    '  s.setTimeout(600, () => finish(false))',
    '})',
    '// 有没有真实窗口：进程活着不等于起来了（可能卡在 node 模式、或崩了但进程还在）',
    '// 注意 "unknown"（PowerShell 还没跟上、查询超时）不代表失败，只代表这次没结论。',
    'const hasWindow = (pid) => {',
    '  const ps = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { $p.MainWindowHandle } else { "gone" }`',
    '  try {',
    '    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 8000 })',
    '    const v = String(out).trim()',
    '    if (v === "gone") return "gone"',
    '    if (v === "0" || v === "") return "no-window"',
    '    return "window"',
    '  } catch { return "unknown" }',
    '}',
    '// 收掉上一轮残留的进程（GPU / 渲染器 / 插件后台）。',
    '// 判据是启动时间：新实例整棵树都晚于新主进程，所以按时间切绝对安全，',
    '// 不会误杀刚起来的那个。按「孤儿」定义反而危险 —— helper 一退出，新主进程也算孤儿。',
    'const reapStale = (newPid) => {',
    '  const ps = `Get-CimInstance Win32_Process -Filter "name=\'${p.exeName}\'" | Select-Object ProcessId,CreationDate | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc())" }`',
    '  try {',
    '    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 15000 })',
    '    const rows = String(out).split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean).map((line) => {',
    '      const parts = line.split(/\\s+/)',
    '      return { pid: Number(parts[0]), born: Number(parts[1]) }',
    '    }).filter((r) => Number.isInteger(r.pid) && r.pid > 1 && Number.isFinite(r.born))',
    '    const mine = rows.find((r) => r.pid === newPid)',
    '    if (mine === undefined) { note("reap: cannot read new instance start time; skipped"); return -1 }',
    '    // 排除自己：helper 也是用同一个 exe 跑起来的，启动时间还更早，',
    '    // 不排除的话第一刀就把自己砍了 —— 这就是之前一直没日志的原因。',
    '    const stale = rows.filter((r) => r.pid !== newPid && r.pid !== process.pid && r.born < mine.born)',
    '    if (stale.length === 0) { note("reap: no stale processes"); return 0 }',
    '    let killed = 0',
    '    for (const r of stale) { if (killPid(r.pid)) killed += 1 }',
    '    note(`reap: ended ${killed}/${stale.length} stale processes`)',
    '    return killed',
    '  } catch (e) { note(`reap skipped: ${e && e.message ? e.message : e}`); return -1 }',
    '}',
    'const waitFor = async (pred, ms, step) => {',
    '  const end = Date.now() + ms',
    '  while (Date.now() < end) { if (await pred()) return true; await sleep(step) }',
    '  return await pred()',
    '}',
    'const alertUser = (text) => {',
    '  const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify(text)}, "DeepSeek Harness") | Out-Null`',
    '  const encoded = Buffer.from(script, "utf16le").toString("base64")',
    '  for (const shell of ["powershell.exe", "pwsh.exe"]) {',
    '    try { const c = spawn(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { detached: true, stdio: "ignore", windowsHide: true }); c.unref(); return true } catch {}',
    '  }',
    '  return false',
    '}',
    'const main = async () => {',
    '  await sleep(p.delayMs)',
    '  if (p.mainPid) {',
    '    note(`ending electron main process ${p.mainPid}`)',
    '    const ok = killPid(p.mainPid)',
    '    note(ok ? `taskkill /PID ${p.mainPid} /F ok` : `taskkill reported an error for ${p.mainPid}`)',
    '    await waitFor(() => !alive(p.mainPid), 15000, 200)',
    '  } else {',
    '    note("no main pid; ending host directly")',
    '    if (p.hostPid) killPid(p.hostPid)',
    '  }',
    '  // 主进程没了之后，宿主会因 IPC 断开自行退出；这里只等端口释放。',
    '  if (p.port) {',
    '    const freed = await waitFor(async () => !(await listening(p.port)), 25000, 300)',
    '    note(freed ? `port ${p.port} released` : `port ${p.port} still held`)',
    '  }',
    '  if (alive(p.hostPid)) { note(`host ${p.hostPid} still alive; ending it`); killPid(p.hostPid) }',
    '  if (!p.restart) { note("shutdown complete"); return }',
    '  // 重启：清理环境变量，否则新实例会以 node 模式启动、没有窗口。',
    '  const env = { ...process.env }',
    '  for (const key of Object.keys(env)) {',
    '    const upper = key.toUpperCase()',
    '    if (upper === "ELECTRON_RUN_AS_NODE" || upper === "DSH_DESKTOP_NODE_EXECUTABLE") delete env[key]',
    '  }',
    '  if (!p.exe || !fs.existsSync(p.exe)) { note(`executable missing: ${p.exe}`); alertUser("重启失败：找不到应用路径。请手动启动 DeepSeek Harness。"); return }',
    '  // 主进程带单例锁：旧实例没彻底走干净时，新实例会自己 quit。多等一会儿。',
    '  await sleep(1200)',
    '  let launched = null',
    '  for (let attempt = 1; attempt <= 5; attempt += 1) {',
    '    if (attempt > 1) { note(`retry ${attempt}/5`); await sleep(3000) }',
    '    let exited = null',
    '    try {',
    '      const child = spawn(p.exe, [], { detached: true, stdio: "ignore", windowsHide: false, cwd: p.cwd, env })',
    '      child.on("error", (e) => { exited = `spawn error: ${e && e.message ? e.message : e}` })',
    '      child.on("exit", (code, signal) => { exited = `exited code=${code} signal=${signal}` })',
    '      child.unref()',
    '      note(`relaunched ${p.exe} as pid ${child.pid}`)',
    '      // 进程活着不算成功：等它真的把窗口画出来，或者确定它已经死了。',
    '      // "unknown" 只是这次没探到结论（PowerShell 还没跟上），继续等，不当失败。',
    '      const deadline = Date.now() + (p.windowWaitMs || 30000)',
    '      let state = "no-window"',
    '      while (Date.now() < deadline) {',
    '        if (exited !== null) break',
    '        if (!alive(child.pid)) { state = "died"; break }',
    '        state = hasWindow(child.pid)',
    '        if (state === "window") break',
    '        await sleep(800)',
    '      }',
    '      if (exited === null && state === "window") { launched = child.pid; break }',
    '      // 超时时如果进程还活着、且始终没探到明确故障，就当它起来了 ——',
    '      // 宁可少杀一次，也不要因为探测不到而把好好的实例打掉。',
    '      if (exited === null && alive(child.pid) && state !== "no-window" && state !== "died") {',
    '        note(`attempt ${attempt}: window probe inconclusive (${state}), process still alive; treating as started`)',
    '        launched = child.pid',
    '        break',
    '      }',
    '      note(`attempt ${attempt} failed: ${exited || state}`)',
    '      if (exited === null && alive(child.pid)) { note(`killing windowless pid ${child.pid}`); killPid(child.pid) }',
    '      await sleep(1200)',
    '    } catch (e) { note(`spawn threw: ${e && e.message ? e.message : e}`) }',
    '  }',
    '  if (launched === null) { note("relaunch failed"); alertUser("重启失败：应用没有起来。请手动启动 DeepSeek Harness。") }',
    '  else {',
    '    note(`restart complete (pid ${launched})`)',
    '    // 立刻收残留：helper 随时可能被回收，别把清理留给后面的 sleep',
    '    reapStale(launched)',
    '  }',
    '}',
    'main().catch((e) => { note(`helper crashed: ${e && e.message ? e.message : e}`); alertUser("重启失败，请手动启动 DeepSeek Harness。") })',
  ].join('\n')
}

function sameOrigin(req) {
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

export function apply(ctx) {
  const logger = ctx.logger
  const facts = runtimeFacts()
  const mainPid = mainProcessOf(facts)
  let busy = false

  const readPort = () => {
    try {
      const match = /:(\d{2,5})$/.exec(ctx.webServer.getOrigin())
      return match === null ? null : Number(match[1])
    } catch {
      return null
    }
  }

  const reply = (res, status, payload) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  /** 拉起 detached helper，把收尾工作交给它。 */
  const handoff = (restart) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const logs = {
      out: join(tmpdir(), `dsh-power-switch-${stamp}.out.log`),
      err: join(tmpdir(), `dsh-power-switch-${stamp}.err.log`),
    }
    const payload = {
      mainPid,
      hostPid: process.pid,
      port: readPort(),
      exe: facts.execPath,
      exeName: facts.execPath ? basename(facts.execPath) : undefined,
      cwd: facts.execPath ? dirname(facts.execPath) : undefined,
      restart,
      delayMs: EXIT_DELAY_MS,
      logMaxBytes: LOG_MAX_BYTES,
      windowWaitMs: WINDOW_WAIT_MS,
      logOut: logs.out,
      logErr: logs.err,
    }
    const runner = facts.electron
      ? { file: facts.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
      : { file: process.execPath, env: {} }
    let helper
    try {
      helper = spawn(runner.file, ['-e', helperSource(payload)], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ...runner.env },
        windowsHide: true,
      })
      helper.once?.('error', (error) => {
        logger?.warn?.(`dsh-power-switch: helper failed (${error?.message ?? error})`)
      })
      helper.unref()
    } catch (error) {
      return { ok: false, error: `could not start the helper: ${error?.message ?? error}` }
    }
    busy = true
    return { ok: true, helperPid: helper.pid ?? null, mainPid, hostPid: process.pid, logs }
  }

  const handle = async (req, res) => {
    if (req.method === 'GET') {
      const action = new URL(req.url ?? ROUTE, 'http://127.0.0.1').searchParams.get('action')
      if (action === 'ping') {
        reply(res, 200, { ok: true, alive: true, pid: process.pid, port: readPort() })
        return
      }
      reply(res, 200, {
        ok: true,
        plugin: name,
        version: PLUGIN_VERSION,
        build: BUILD_TAG,
        alive: true,
        busy,
        pid: process.pid,
        port: readPort(),
        facts,
        restartable: mainPid !== null,
      })
      return
    }

    if (req.method !== 'POST') {
      reply(res, 405, { ok: false, error: 'GET to inspect, POST to act' })
      return
    }
    if (!sameOrigin(req)) {
      reply(res, 403, { ok: false, error: 'cross-origin request refused' })
      return
    }
    if (busy) {
      reply(res, 409, { ok: false, error: 'a power operation is already in flight' })
      return
    }

    const url = new URL(req.url ?? ROUTE, 'http://127.0.0.1')
    const action = String(url.searchParams.get('action') ?? req.headers['x-power-action'] ?? '').toLowerCase()

    if (action === 'restart' || action === 'reboot') {
      if (mainPid === null) {
        reply(res, 409, {
          ok: false,
          error: 'this host was not started by the desktop app; restart is unavailable here',
          facts,
        })
        return
      }
      const outcome = handoff(true)
      reply(res, outcome.ok === true ? 202 : 500, { ...outcome, action: 'restart' })
      return
    }
    if (action === 'shutdown' || action === 'close' || action === 'stop') {
      const outcome = handoff(false)
      reply(res, outcome.ok === true ? 202 : 500, { ...outcome, action: 'shutdown' })
      return
    }
    reply(res, 400, { ok: false, error: `unknown action: ${action || '(empty)'}` })
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      handler: (req, res) => {
        void handle(req, res).catch((error) => {
          try {
            reply(res, 500, { ok: false, error: String(error?.message ?? error) })
          } catch {
            /* response already gone */
          }
        })
      },
    }),
  )

  logger?.info?.(
    'dsh-power-switch: mounted at %s (host pid %d, main pid %s)',
    ROUTE,
    process.pid,
    mainPid === null ? 'n/a' : String(mainPid),
  )
}
