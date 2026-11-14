import Schema from '@deepseek-ai/schemastery'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export const name = 'hypoparathyroidism-main'
export const inject = ['webServer', 'connection']
/* config.root 由 cordis.patch.yml 注入（dshHomePath('hypoparathyroidism')）：
   工作台数据根目录；资料目录切换在此基础上落盘。 */
export const Config = Schema.object({
  root: Schema.string().description('资料目录根（DSH Desktop 按 dshHomePath 注入）'),
})
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const HOME_EXACT = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)$/i
const FORBIDDEN_DIR = /((Desktop|桌面)$|(Downloads?|下载(夹)?)$|^(\/tmp|\/private\/tmp|\/var\/folders\/|\/private\/var\/folders\/))/i
const isForbiddenDir = (dir) => HOME_EXACT.test(dir) || FORBIDDEN_DIR.test(dir)

export function apply(ctx, config = {}) {
  if (!ctx.webServer?.register) throw new Error('Desktop webServer.register is unavailable')
  let dataRoot = config?.root || ''

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const guard = (req, res) => {
    if (typeof ctx.connection?.requestRejection !== 'function') return send(res, 503, { error: 'connection authentication capability unavailable' })
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) return send(res, rejection, { error: 'Authentication required' })
    return undefined
  }

  /* ---- 患者档案层（骨架版；M3 换正式 schema/0001_initial.sql） ---- */
  let db = null
  let dbError = null
  try {
    if (dataRoot) {
      mkdirSync(dirname(join(dataRoot, 'workbench.db')), { recursive: true })
      db = new DatabaseSync(join(dataRoot, 'workbench.db'))
      db.exec(`CREATE TABLE IF NOT EXISTS subjects (
        profile_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`)
      const count = db.prepare('SELECT COUNT(*) AS n FROM subjects').get().n
      if (count === 0) {
        const now = new Date().toISOString()
        const ins = db.prepare('INSERT INTO subjects (profile_key, name, is_demo, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
        ins.run('demo-a', '示例档案 A（刚确诊 · 记录少）', now, now)
        ins.run('demo-b', '示例档案 B（长期随访 · 记录多）', now, now)
      }
    }
  } catch (error) { dbError = error.message }
  let currentProfileKey = 'demo-a'
  const listSubjects = () => db ? db.prepare('SELECT profile_key, name, is_demo, created_at, updated_at FROM subjects ORDER BY rowid').all() : null

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/hypoparathyroidism/subjects',
    handler(req, res) {
      const rejected = guard(req, res)
      if (rejected) return rejected
      if (dbError) return send(res, 503, { error: 'db_unavailable', message: `数据层不可用：${dbError}` })
      if (req.method === 'GET') {
        return send(res, 200, { profiles: listSubjects(), current: currentProfileKey })
      }
      if (req.method === 'POST') {
        let raw = ''
        req.on('data', (chunk) => { raw += chunk })
        req.on('end', () => {
          let name = ''
          try { name = String(JSON.parse(raw || '{}').name || '').trim() } catch { name = '' }
          if (!name) return send(res, 400, { error: 'name_required', message: '档案名不能为空' })
          if (name.length > 60) return send(res, 400, { error: 'name_too_long', message: '档案名最长 60 字' })
          const now = new Date().toISOString()
          const key = `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          db.prepare('INSERT INTO subjects (profile_key, name, is_demo, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').run(key, name, now, now)
          currentProfileKey = key
          send(res, 200, { profileKey: key, name, isDemo: 0 })
        })
        return
      }
      send(res, 405, { error: 'Method not allowed' })
    },
  }), 'hypoparathyroidism subjects')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/hypoparathyroidism/subjects/current',
    handler(req, res) {
      const rejected = guard(req, res)
      if (rejected) return rejected
      if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
      let raw = ''
      req.on('data', (chunk) => { raw += chunk })
      req.on('end', () => {
        let key = ''
        try { key = String(JSON.parse(raw || '{}').profileKey || '') } catch { key = '' }
        const hit = listSubjects()?.find((s) => s.profile_key === key)
        if (!hit) return send(res, 404, { error: 'profile_not_found', message: '档案不存在' })
        currentProfileKey = key
        send(res, 200, { current: key })
      })
    },
  }), 'hypoparathyroidism subjects current')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/hypoparathyroidism/health',
    handler(req, res) {
      const rejected = guard(req, res)
      if (rejected) return rejected
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' })
      send(res, 200, { ok: true, version: manifest.version, apiVersion: 'v1', capabilities: ['health', 'root'] })
    },
  }), 'hypoparathyroidism health')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/hypoparathyroidism/root',
    handler(req, res) {
      const rejected = guard(req, res)
      if (rejected) return rejected
      if (req.method === 'GET') return send(res, 200, { dir: dataRoot })
      if (req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
          let dir = ''
          try { dir = String(JSON.parse(body || '{}').dir || '') } catch { dir = '' }
          if (!dir) return send(res, 400, { error: 'dir_required', message: '缺少目录' })
          if (isForbiddenDir(dir)) {
            return send(res, 400, { error: 'forbidden_dir', message: '主目录本身 / 桌面 / 下载根目录 / tmp 不能作为资料目录' })
          }
          dataRoot = dir
          send(res, 200, { dir: dataRoot })
        })
        return
      }
      send(res, 405, { error: 'Method not allowed' })
    },
  }), 'hypoparathyroidism root')
}
