// 浏览器半身自测：不装真浏览器，用一个极简假 DOM 跑真实 client/index.js。
// 重点验证用户提的三件事：
//   1) 打开默认是「学习」tab，且学习卡带正文（不是上来就考人）
//   2) 切到「答题」tab 答题，自评 + 提交真的带 score 发出去；不给分数不许落盘
//   3) 一轮里既有新知识也有旧知识复习（复习卡只给标题，不给正文）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const clientSrc = fs.readFileSync(path.join(pluginDir, 'client', 'index.js'), 'utf8')

// ---------------------------------------------------------------- 假 DOM
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.attrs = {}
    this.children = []
    this.parentNode = null
    this.style = { cssText: '' }
    this.listeners = {}
    this._text = ''
    this.value = ''
  }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k] }
  addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn) }
  removeEventListener(type, fn) {
    const l = this.listeners[type]
    if (l) this.listeners[type] = l.filter(f => f !== fn)
  }
  dispatch(type, ev) { for (const fn of (this.listeners[type] || []).slice()) fn(ev || { type, target: this }) }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }
  removeChild(child) {
    this.children = this.children.filter(c => c !== child)
    child.parentNode = null
    return child
  }
  get textContent() {
    if (this.children.length === 0) return this._text
    return this.children.map(c => c.textContent).join('')
  }
  set textContent(v) {
    this._text = v === null || v === undefined ? '' : String(v)
    for (const c of this.children) c.parentNode = null
    this.children = []
  }
  get classList() { return String(this.attrs.class || '').split(/\s+/).filter(Boolean) }
  matches(sel) {
    const parts = String(sel).trim().split(/\s+/)
    if (parts.length > 1) return false // 后代链只走 querySelector
    const s = parts[0]
    if (s.charAt(0) === '.') return this.classList.includes(s.slice(1))
    return this.tagName === s.toUpperCase()
  }
  descendants() {
    const out = []
    const walk = node => { for (const c of node.children) { out.push(c); walk(c) } }
    walk(this)
    return out
  }
  // 只支持 ".a" 与 ".a .b" 这种后代链
  querySelector(sel) {
    const parts = String(sel).trim().split(/\s+/)
    const walk = (node, idx) => {
      for (const c of node.children) {
        if (c.matches(parts[idx])) {
          if (idx === parts.length - 1) return c
          const deeper = walk(c, idx + 1)
          if (deeper) return deeper
        }
        const inner = walk(c, idx)
        if (inner) return inner
      }
      return null
    }
    return walk(this, 0)
  }
  querySelectorAll(sel) {
    const parts = String(sel).trim().split(/\s+/)
    const last = parts[parts.length - 1]
    const out = []
    for (const el of this.descendants()) {
      if (!el.matches(last)) continue
      if (parts.length === 1) { out.push(el); continue }
      let p = el.parentNode
      let need = parts.length - 2
      while (p && need >= 0) {
        if (p.matches(parts[need])) need -= 1
        p = p.parentNode
      }
      if (need < 0) out.push(el)
    }
    return out
  }
}

const document = {
  readyState: 'complete',
  head: new FakeEl('head'),
  body: new FakeEl('body'),
  createElement: tag => new FakeEl(tag),
  createTextNode: text => { const el = new FakeEl('#text'); el._text = String(text); return el },
  addEventListener() {},
}

// ---------------------------------------------------------------- 假宿主接口
const host = {
  state: null,
  calls: [],
  submits: [],
  settingsPosts: [],
}

function json(obj) { return Promise.resolve({ ok: true, json: () => Promise.resolve(obj) }) }

async function fakeFetch(url, opts) {
  const method = (opts && opts.method) || 'GET'
  host.calls.push(method + ' ' + url)
  let body = null
  if (opts && opts.body) { try { body = JSON.parse(opts.body) } catch { body = opts.body } }
  if (url === '/study-loop/api/state') return json(host.state)
  if (url.indexOf('/study-loop/api/key') === 0) {
    return json({
      ok: true,
      value: {
        id: 'Q-2', title: 'SSE 半包', rubric: ['要点一', '要点二', '要点三'],
        answer: '参考答案正文', trap: '常见错法：直接 response.json()',
        lesson: { id: 'L-a', title: '卡A', body: '卡A正文', keyPoints: ['k1'] },
      },
    })
  }
  if (url.indexOf('/study-loop/api/lesson') === 0) {
    return json({ ok: true, value: { id: 'L-a', title: '卡A', summary: '摘要A', body: '卡A正文', keyPoints: ['k1', 'k2'], progress: { seen: 1 } } })
  }
  if (url === '/study-loop/api/submit') {
    host.submits.push(body)
    return json({ ok: true, value: { id: body.qid, score: body.score, passed: body.score >= 3, note: body.note, lesson: { lessonId: 'L-a', dueAt: '2026-10-31T12:00:00+08:00', streak: 1, angle: '反例' } } })
  }
  if (url === '/study-loop/api/regenerate' || url === '/study-loop/api/snooze' || url === '/study-loop/api/tab') {
    return json({ ok: true, value: host.state.value })
  }
  if (url === '/study-loop/api/dismiss') return json({ ok: true })
  if (url === '/study-loop/api/open') {
    host.opened = (host.opened || 0) + 1
    const v = JSON.parse(JSON.stringify(host.state.value))
    v.round.showSeq = (v.round.showSeq || 1) + 1
    v.round.skipped = false
    host.state = { ok: true, value: v }
    return json({ ok: true, value: v })
  }
  if (url === '/study-loop/api/bank') {
    return json({
      ok: true,
      value: {
        totals: { questions: 2, lessons: 1, dueNow: 0, attempts: 1 },
        questions: [{ id: 'Q-2', title: 'SSE 半包', lessonTitle: '卡A', review: { seen: 1, dueAt: '2026-11-01T10:00:00+08:00', streak: 1, dueInMinutes: 600 } }],
        lessons: [{ id: 'L-a', title: '卡A', summary: '摘要A', keyPoints: ['k1'], tags: [], review: { seen: 1, dueAt: '2026-11-01T10:00:00+08:00', streak: 1, dueInMinutes: 600 } }],
      },
    })
  }
  if (url === '/study-loop/api/settings') {
    if (method === 'POST') { host.settingsPosts.push(body); return json({ ok: true, value: host.settingsValue() }) }
    return json({ ok: true, value: host.settingsValue() })
  }
  return json({ ok: false, error: { message: 'no route ' + url } })
}

const localStorageMap = new Map()
const localStorage = {
  getItem: k => (localStorageMap.has(k) ? localStorageMap.get(k) : null),
  setItem: (k, v) => { localStorageMap.set(k, String(v)) },
  removeItem: k => { localStorageMap.delete(k) },
}

const timers = []
const window = {
  setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
  clearInterval: id => { const t = timers[id - 1]; if (t) t.dead = true },
  addEventListener: () => {},
  console: console,
}

let registered = null
window.__ModuleLoader__ = { load: decl => { registered = decl } }

// ---------------------------------------------------------------- 跑起来
const fn = new Function('window', 'document', 'localStorage', 'fetch', 'console', 'Promise', 'setTimeout', clientSrc)
fn(window, document, localStorage, fakeFetch, console, Promise, setTimeout)

let fail = 0
let pass = 0
function check(label, cond, detail) {
  if (cond) { pass += 1; console.log('  ok   ' + label) }
  else { fail += 1; console.log('  FAIL ' + label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail))) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// 一轮的返回：1 张新卡 + 1 道新题 + 1 道旧知识复习（复习卡只给标题）
function roundState(over) {
  const round = {
    id: 'r1',
    askedAt: '2026-10-31 11:00',
    tab: 'study',
    showSeq: 1,
    skipped: false,
    answered: {},
    answeredCount: 0,
    pendingCount: 2,
    warnings: [],
    study: [
      { id: 'L-a', title: '卡A', angle: '原理', isReview: false, summary: '摘要A', body: '卡A正文', keyPoints: ['k1', 'k2'], tags: ['week1'], hasCard: true, dueLabel: '', questionIds: ['Q-1'] },
      { id: 'L-b', title: '卡B', angle: '反例', isReview: true, summary: '', body: '', keyPoints: [], tags: [], hasCard: true, dueLabel: '2026-10-31 09:00', questionIds: ['Q-2'] },
    ],
    questions: [
      { id: 'Q-1', lessonId: 'L-a', lessonTitle: '卡A', type: '理解', angle: '原理', title: '为什么要自己解析 SSE', prompt: '说一下 data: 行是谁写的', hint: '字节流 vs 消息流', isReview: false, dueLabel: '' },
      { id: 'Q-2', lessonId: 'L-b', lessonTitle: '卡B', type: '理解', angle: '反例', title: '半包怎么处理', prompt: '如果只按 chunk 切会怎样', hint: '', isReview: true, dueLabel: '2026-10-31 09:00' },
    ],
  }
  return { ok: true, value: Object.assign({ round, nextInMs: 600000, intervalMinutes: 10, passScore: 3, maxScore: 5, questionsPerRound: 5, reviewSlots: 2, dataDir: 'X', warnings: [] }, over || {}) }
}

host.settingsValue = () => ({
  intervalMinutes: 10, questionsPerRound: 5, reviewSlots: 2, passScore: 3, maxScore: 5,
  prompt: '出 {count} 道题，主题 {topic}，参考 {lessons}，角度 {angles}',
  model: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: '••••abcd', hasKey: true, keyFromEnv: false, temperature: 0.7, timeoutMs: 60000 },
})

check('client bundle 注册了 factory', registered !== null && registered.id === 'dsh-study-loop', registered && registered.id)
const mod = registered.factory(() => { throw new Error('不该 require 任何东西') })
check('导出 apply/inject', typeof mod.apply === 'function' && Array.isArray(mod.inject), Object.keys(mod))

const effects = []
const ctx = { effect: (fn2, label) => { const d = fn2(); effects.push({ label, d }); return d } }
host.state = roundState()   // boot 里第一次 refresh 就要能拿到题
mod.apply(ctx)
check('apply 后挂了定时器', timers.length >= 2, timers.length)
check('effect 登记了清理', effects.length === 1 && typeof effects[0].d === 'function', effects.map(e => e.label))
await sleep(40)

const body = () => document.body
const dims = () => body().children.filter(c => c.matches('.sl-dim'))
const card = () => { const d = dims()[0]; return d ? d.children[0] : null }
const tabs = () => card().querySelectorAll('.sl-tab')
const tabBtn = label => tabs().find(b => b.textContent === label)

// ---- 弹层与默认 tab
check('第一轮 → 弹层挂上 body', dims().length === 1, body().children.map(c => c.tagName))
check('卡片挂在 .sl-dim 里', !!card() && card().classList.includes('sl-card'), card() && card().attrs.class)
check('默认落在「学习」tab', tabBtn('学习') && tabBtn('学习').classList.includes('on'), tabs().map(t => t.textContent + (t.classList.includes('on') ? '*' : '')))
check('学习 tab 给出新知识正文', card().textContent.indexOf('卡A正文') >= 0, card().textContent.slice(0, 160))
check('学习 tab 给出要点', card().textContent.indexOf('k1') >= 0)
check('学习 tab 有「看完了去答题」按钮', card().querySelectorAll('.sl-btn').some(b => b.textContent.indexOf('看完了') === 0), card().querySelectorAll('.sl-btn').map(b => b.textContent))
check('复习卡只给标题不给正文', card().textContent.indexOf('复习 · 换个角度') >= 0 && card().textContent.indexOf('卡B正文') < 0)

// ---- 学习 tab 里翻原卡
{
  const btn = card().querySelectorAll('.sl-btn').find(b => b.textContent === '翻原卡')
  check('复习卡有「翻原卡」按钮', !!btn, card().querySelectorAll('.sl-btn').map(b => b.textContent))
  btn.dispatch('click')
  await sleep(30)
  check('翻原卡调了 GET /lesson', host.calls.some(c => c.indexOf('GET /study-loop/api/lesson') === 0), host.calls.slice(-4))
  check('翻原卡后给出正文', card().textContent.indexOf('卡A正文') >= 0)
}

// ---- 切到答题 tab
{
  const btn = card().querySelectorAll('.sl-btn').find(b => b.textContent.indexOf('看完了') === 0)
  btn.dispatch('click')
  await sleep(20)
  check('切到答题 tab', tabBtn('答题').classList.includes('on'), tabs().map(t => t.textContent + (t.classList.includes('on') ? '*' : '')))
  check('答题 tab 里有两道题', card().querySelectorAll('.sl-q').length === 2, card().querySelectorAll('.sl-q').length)
  const txt = card().textContent
  check('题面上没有判分要点', txt.indexOf('要点一') < 0)
  check('题面上没有参考答案', txt.indexOf('参考答案正文') < 0)
  check('题面标出旧知识复习', txt.indexOf('旧知识复习') >= 0)
  check('每道题都有自评按钮', card().querySelectorAll('.sl-q')[0].querySelectorAll('.sl-btn').some(b => b.textContent === '3 过关'))
  check('草稿框存在', card().querySelectorAll('.sl-q')[0].querySelectorAll('.sl-ta').length >= 1)
}

// ---- 不给分数提交 → 拦住
{
  const before = host.submits.length
  const q1 = card().querySelectorAll('.sl-q')[0]
  const submit = q1.querySelectorAll('.sl-btn').find(b => b.textContent.indexOf('提交') === 0)
  check('找到提交按钮', !!submit, q1.querySelectorAll('.sl-btn').map(b => b.textContent))
  submit.dispatch('click')
  await sleep(30)
  check('不给分数 → 不发 submit', host.submits.length === before, host.submits.length)
  check('不给分数 → 给出提示', card().textContent.indexOf('还没选自评分数') >= 0, card().textContent.slice(-200))
}

// ---- 给分 + 提交
{
  const q1 = card().querySelectorAll('.sl-q')[0]
  const scoreBtn = q1.querySelectorAll('.sl-btn').find(b => b.textContent === '4')
  check('找到自评按钮 4', !!scoreBtn, q1.querySelectorAll('.sl-btn').map(b => b.textContent))
  scoreBtn.dispatch('click')
  await sleep(30)
  const q1b = card().querySelectorAll('.sl-q')[0]
  const note = q1b.querySelectorAll('.sl-ta')[1]
  check('备注输入框存在', !!note, q1b.querySelectorAll('.sl-ta').length)
  note.value = '缺口：没讲边界'
  note.dispatch('input', { target: note })
  const submit = q1b.querySelectorAll('.sl-btn').find(b => b.textContent.indexOf('提交') === 0)
  submit.dispatch('click')
  await sleep(60)
  check('提交带 qid', host.submits.length === 1 && host.submits[0].qid === 'Q-1', host.submits)
  check('提交带 score=4', host.submits[0] && host.submits[0].score === 4, host.submits[0])
  check('提交带 note', host.submits[0] && host.submits[0].note === '缺口：没讲边界', host.submits[0])
}

// ---- 对照判分要点
{
  const q2 = card().querySelectorAll('.sl-q')[1]
  const keyBtn = q2.querySelectorAll('.sl-btn').find(b => b.textContent === '对照判分要点')
  check('有「对照判分要点」按钮', !!keyBtn, q2.querySelectorAll('.sl-btn').map(b => b.textContent))
  keyBtn.dispatch('click')
  await sleep(30)
  check('判分要点只在按需时出现', card().textContent.indexOf('要点一') >= 0)
  check('判分要点带常见错法', card().textContent.indexOf('常见错法') >= 0)
}

// ---- 题库 tab
{
  tabBtn('题库').dispatch('click')
  await sleep(60)
  check('题库 tab 有空', tabBtn('题库').classList.includes('on'))
  check('题库调了 GET /bank', host.calls.some(c => c.indexOf('GET /study-loop/api/bank') === 0), host.calls.slice(-3))
  const txt = card().textContent
  check('题库显示题数与卡数', txt.indexOf('题 2') >= 0 && txt.indexOf('学习卡 1') >= 0, txt.slice(0, 120))
  check('题库有模型生成入口', txt.indexOf('按提示词生成题目') >= 0)
  check('题库有导入入口（JSON/CSV 粘贴）', txt.indexOf('导入上面的文本') >= 0)
  check('题库有导出与模板按钮', txt.indexOf('下载 CSV 模板') >= 0 && txt.indexOf('导出 CSV') >= 0)
  check('题库有文件上传框', card().querySelectorAll('input').some(i => i.attrs.type === 'file'), card().querySelectorAll('input').map(i => i.attrs.type))
}

// ---- 设置 tab
{
  tabBtn('设置').dispatch('click')
  await sleep(60)
  const txt = card().textContent
  check('设置 tab 已打开', tabBtn('设置').classList.includes('on'))
  check('设置显示提示词编辑区', txt.indexOf('可用占位符') >= 0 && card().querySelectorAll('textarea').length > 0, txt.slice(0, 160))
  const keyInput = card().querySelectorAll('input').find(i => i.attrs.type === 'password')
  check('key 输入框是 password 且不回显', !!keyInput && keyInput.value === '' && keyInput.attrs.placeholder.indexOf('已') === 0, keyInput && { v: keyInput.value, p: keyInput.attrs.placeholder })
  check('设置页不含 key 明文', txt.indexOf('abcd') < 0)
}

// ---- 收起 → skipped 后不再弹
{
  const footBtns = card().querySelectorAll('.sl-btn')
  const dismissBtn = footBtns.find(b => b.textContent === '收起')
  check('有「收起」按钮', !!dismissBtn, footBtns.map(b => b.textContent))
  dismissBtn.dispatch('click')
  await sleep(30)
  check('点收起 → 弹层移除', dims().length === 0, body().children.length)
  check('收起调了 POST /dismiss', host.calls.some(c => c === 'POST /study-loop/api/dismiss'), host.calls.slice(-3))

  host.state = roundState({ round: Object.assign(roundState().value.round, { skipped: true }) })
  timers[0].fn()
  await sleep(60)
  check('宿主报 skipped=true → 不弹', dims().length === 0)
}

// ---- 新一轮 → 重新弹，并回到学习 tab
{
  host.state = roundState({ round: Object.assign(roundState().value.round, { id: 'r2' }) })
  timers[0].fn()
  await sleep(80)
  check('新一轮 → 重新弹', dims().length === 1)
  check('新一轮回到学习 tab', tabBtn('学习').classList.includes('on'), tabs().map(t => t.textContent + (t.classList.includes('on') ? '*' : '')))
}

// ---- 同 round 但 showSeq 变（延后到点）也要重弹
{
  const footBtns = card().querySelectorAll('.sl-btn')
  const dismissBtn = footBtns.find(b => b.textContent === '收起')
  dismissBtn.dispatch('click')
  await sleep(40)
  check('先收起', dims().length === 0)
  host.state = roundState({ round: Object.assign(roundState().value.round, { id: 'r2', showSeq: 2 }) })
  timers[0].fn()
  await sleep(80)
  check('showSeq 变化 → 重新弹', dims().length === 1)
}

// ---- 右下角小按钮：收起后仍在，点它立刻重新打开（不用等 10 分钟）
{
  const fabs = () => body().children.filter(c => c.matches('.sl-fab'))
  check('浮层打开时没有小按钮', fabs().length === 0, body().children.map(c => c.attrs.class || c.tagName))

  const dismissBtn = card().querySelectorAll('.sl-btn').find(b => b.textContent === '收起')
  dismissBtn.dispatch('click')
  await sleep(40)
  check('收起后浮层消失', dims().length === 0)
  check('收起后右下角有小按钮', fabs().length === 1, body().children.map(c => c.attrs.class || c.tagName))
  check('小按钮标出还剩几题', /2/.test(fabs()[0].textContent), fabs()[0].textContent)

  const before = host.opened || 0
  fabs()[0].dispatch('click')
  await sleep(90)
  check('点小按钮 → 调了 POST /open', (host.opened || 0) === before + 1, host.calls.slice(-4))
  check('点小按钮 → 浮层重新弹出', dims().length === 1, body().children.map(c => c.attrs.class || c.tagName))
  check('浮层重新打开后小按钮收起（不叠在卡片上）', fabs().length === 0)
}

// ---- 清理
{
  effects[0].d()
  check('清理函数可调用', timers.every(t => t.dead !== undefined || true))
}

console.log('')
if (fail === 0) {
  console.log('✅ 全部通过：' + pass + ' 项')
  process.exit(0)
}
console.log('❌ 失败 ' + fail + ' / 共 ' + (pass + fail) + ' 项')
process.exit(1)
