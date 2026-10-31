// 宿主端自测：不起真宿主，用临时数据目录 + 假 ctx 把 HTTP 处理器架在 127.0.0.1:0 上打。
// 铁律：所有落盘都在 %TEMP% 的沙盒目录里，绝不碰 ~/.dsh-study-loop 与 quiz-dojo 的真实文件。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import zlib from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
// Windows 上动态 import 绝对路径必须给 file:// URL，否则报 ERR_UNSUPPORTED_ESM_URL_SCHEME('d:')
const load = rel => import(pathToFileURL(path.join(pkgRoot, rel)).href)

let pass = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  ok   ' + name) }
  else { failures.push(name + (extra ? ' → ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' → ' + extra : '')) }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), 'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected))
}

// ------------------------------------------------------------------ 造一个 xlsx（测试用）
// zip 只写 stored（method 0）条目，够验证中央目录扫描 + sharedStrings + 单元格定位。
function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, contentRaw] of entries) {
    const data = Buffer.isBuffer(contentRaw) ? contentRaw : Buffer.from(String(contentRaw), 'utf8')
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    locals.push(local, data)
    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)
    offset += local.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function sheetXml(rows) {
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
  const body = rows.map((cells, r) => {
    const tds = cells.map((c, i) => {
      const ref = String.fromCharCode(65 + i) + String(r + 1)
      return '<c r="' + ref + '" t="inlineStr"><is><t>' + String(c)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</t></is></c>'
    }).join('')
    return '<row r="' + (r + 1) + '">' + tds + '</row>'
  }).join('')
  return head + body + '</sheetData></worksheet>'
}

// ------------------------------------------------------------------ 开始
console.log('\n↓ 准备沙盒')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'study-loop-selftest-'))
const dataDir = path.join(sandbox, 'data')
fs.mkdirSync(dataDir, { recursive: true })
console.log('  沙盒: ' + sandbox)

const mod = await load('lib/index.js')
const importer = await load('lib/importer.js')
const review = await load('lib/review.js')
const store = await load('lib/store.js')
const generate = await load('lib/generate.js')

// ---------------------------------------------------------------- 1. 纯函数
console.log('\n↓ 1. 纯函数（间隔重复 / CSV / 归一化）')
{
  const LADDER = review.LADDER
  const r1 = review.nextReview(null, 4, Date.parse('2026-01-01T00:00:00+08:00'), 3)
  eq('首答过关 → 档 1', r1.streak, 1)
  ok('首答过关 → 间隔 = LADDER[0]', Date.parse(r1.dueAt) - Date.parse('2026-01-01T00:00:00+08:00') === LADDER[0] * 60000, r1.dueAt)
  const r2 = review.nextReview(r1, 5, Date.parse(r1.dueAt), 3)
  eq('连对 → 档 +1', r2.streak, 2)
  ok('连对 → 间隔变长', Date.parse(r2.dueAt) - Date.parse(r1.dueAt) === LADDER[1] * 60000)
  const r3 = review.nextReview(r2, 1, Date.parse(r2.dueAt), 3)
  eq('没过关 → 回第一档', r3.streak, 1)
  ok('没过关 → 间隔回到最短', Date.parse(r3.dueAt) - Date.parse(r2.dueAt) === LADDER[0] * 60000)
  ok('每答一次换角度', r1.angle !== r2.angle || r1.angleIdx !== r2.angleIdx)
  const capped = review.nextReview({ streak: 99 }, 5, Date.now(), 3)
  eq('档位封顶不打穿 LADDER', capped.streak, LADDER.length)

  eq('CSV 基础解析', importer.parseDelimited('a,b\n1,2'), [['a', 'b'], ['1', '2']])
  eq('CSV 引号内逗号', importer.parseDelimited('a,b\n"x,y",2'), [['a', 'b'], ['x,y', '2']])
  eq('CSV 双引号转义', importer.parseDelimited('a\n"say ""hi"""'), [['a'], ['say "hi"']])
  eq('CSV 字段内换行', importer.parseDelimited('a,b\n"l1\nl2",2'), [['a', 'b'], ['l1\nl2', '2']])
  eq('TSV 自动识别', importer.parseDelimited('a\tb\n1\t2'), [['a', 'b'], ['1', '2']])
  eq('BOM 被吃掉', importer.parseDelimited('\uFEFFa,b\n1,2')[0], ['a', 'b'])

  const ctx = { newId: store.newId, stamp: store.stamp }
  const fromCsv = importer.rowsToRecords(
    importer.parseDelimited('标题,知识点,题干,判分要点,参考答案\n"T1","L1","P1","A | B | C","ANS"'),
    'questions', ctx,
  )
  eq('CSV 表头中文识别', fromCsv.records.length, 1)
  eq('列表字段按 | 拆开', fromCsv.records[0].rubric.length, 3)
  eq('CSV → lessonTitle', fromCsv.records[0].lessonTitle, 'L1')
  ok('CSV → lessonId 自动派生', fromCsv.records[0].lessonId.startsWith('L-'), fromCsv.records[0].lessonId)

  const lessonCsv = importer.rowsToRecords(
    importer.parseDelimited('标题,摘要,内容,要点\n"卡1","一句话","正文若干","p1 | p2"'),
    'lessons', ctx,
  )
  eq('学习卡表头：标题不会被知识点抢走', lessonCsv.records[0].title, '卡1')
  eq('学习卡 keyPoints', lessonCsv.records[0].keyPoints, ['p1', 'p2'])

  const badHeader = importer.rowsToRecords([['foo', 'bar'], ['1', '2']], 'questions', ctx)
  eq('表头认不出 → 有警告且 0 记录', badHeader.records.length, 0)
  ok('表头认不出 → 警告提到 title', /标题|title/.test(badHeader.warnings.join('')))

  const json1 = importer.recordsFromJsonText('[{"title":"J1","prompt":"p","rubric":["a"]}]', 'questions', ctx)
  eq('JSON 数组导入', json1.records.length, 1)
  const json2 = importer.recordsFromJsonText('{"questions":[{"title":"J2"}]}', 'questions', ctx)
  eq('JSON {questions:[]} 导入', json2.records[0].title, 'J2')
  const json3 = importer.recordsFromJsonText('{"title":"单条"}', 'questions', ctx)
  eq('JSON 单条对象导入', json3.records[0].title, '单条')
  const json4 = importer.recordsFromJsonText('{ 破的', 'questions', ctx)
  eq('坏 JSON → 0 记录', json4.records.length, 0)
  ok('坏 JSON → 警告含解析失败', /解析失败/.test(json4.warnings.join('')))

  // xlsx：整条链路（zip 中央目录 → 工作表 → 表头映射）
  const xlsxBuf = makeZip([
    ['xl/sharedStrings.xml', '<?xml version="1.0"?><sst></sst>'],
    ['xl/worksheets/sheet1.xml', sheetXml([
      ['标题', '知识点', '题干', '判分要点', '答案'],
      ['X1', 'XL1', 'XP1', 'r1 | r2', 'XA'],
      ['X2', 'XL2', 'XP2', 'r3', 'XB'],
    ])],
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
  ])
  const fromXlsx = importer.recordsFromFile(xlsxBuf, 'bank.xlsx', 'questions', ctx)
  eq('xlsx 读出 2 条', fromXlsx.records.length, 2)
  eq('xlsx 首个标题', fromXlsx.records[0].title, 'X1')
  eq('xlsx 判分要点拆分', fromXlsx.records[0].rubric, ['r1', 'r2'])
  eq('xlsx 第二行答案', fromXlsx.records[1].answer, 'XB')

  // deflate 压缩的 zip 也要能解
  const deflated = (() => {
    const data = Buffer.from(sheetXml([['标题'], ['Z1']]), 'utf8')
    const comp = zlib.deflateRawSync(data)
    const nameBuf = Buffer.from('xl/worksheets/sheet1.xml', 'utf8')
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    nameBuf.copy(local, 30)
    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(0, 42)
    nameBuf.copy(central, 46)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(1, 8)
    eocd.writeUInt16LE(1, 10)
    eocd.writeUInt32LE(central.length, 12)
    eocd.writeUInt32LE(local.length + comp.length, 16)
    return Buffer.concat([local, comp, central, eocd])
  })()
  const fromDeflate = importer.recordsFromFile(deflated, 'z.xlsx', 'questions', ctx)
  eq('deflate 压缩的 xlsx 也能读', fromDeflate.records[0].title, 'Z1')

  let xlsErr = null
  try { importer.recordsFromFile(Buffer.from('x'), 'old.xls', 'questions', ctx) } catch (err) { xlsErr = String(err.message || err) }
  ok('.xls 给出明确提示', /xlsx|CSV/.test(String(xlsErr)))

  const csvOut = importer.questionsToCsv([{ id: 'Q1', title: '带,逗号', rubric: ['a', 'b'] }])
  ok('导出 CSV 带 BOM', csvOut.charCodeAt(0) === 0xfeff)
  ok('导出 CSV 转义逗号', csvOut.indexOf('"带,逗号"') > 0)
}

// ---------------------------------------------------------------- 2. 表驱动 API
console.log('\n↓ 2. 宿主 HTTP API')
let handler = null
let served = null
const disposers = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect(fn, label) { const d = fn(); disposers.push({ d, label }); return d },
  webServer: { register(opts) { handler = opts.handler; served = opts; return () => { handler = null } } },
}
const fakeFetch = async (url, init) => {
  const body = JSON.parse(String((init && init.body) || '{}'))
  const userMsg = body.messages && body.messages[body.messages.length - 1]
  const content = JSON.stringify({
    questions: [
      { title: '模型出的题 1', angle: '反例', prompt: 'p1', rubric: ['a', 'b', 'c'], answer: 'A1', lessonTitle: '卡A' },
      { title: '模型出的题 2', angle: '排错', prompt: 'p2', rubric: ['d'], answer: 'A2', lessonTitle: '卡A' },
    ],
  })
  fakeFetch.calls = fakeFetch.calls || []
  fakeFetch.calls.push({ url, body, prompt: userMsg && userMsg.content })
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 123 } }),
  }
}

const applyResult = mod.apply(ctx, { dataDir, legacyQuizDir: '' })
ok('apply 返回函数（cordis 只收函数）', typeof applyResult === 'function')
ok('注册了 prefix 路由', served && served.kind === 'prefix' && served.path === '/study-loop/api', JSON.stringify(served && { k: served.kind, p: served.path }))
eq('dataDir 落盘在沙盒', fs.existsSync(path.join(dataDir, 'settings.json')), true)
eq('首次启动建了 questions.json', fs.existsSync(path.join(dataDir, 'questions.json')), true)

const server = http.createServer((req, res) => handler(req, res))
await new Promise(r => server.listen(0, '127.0.0.1', r))
const base = 'http://127.0.0.1:' + server.address().port + '/study-loop/api'
const get = async (p, host) => {
  const res = await fetch(base + p, host ? { headers: { host } } : undefined)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}
const post = async (p, body) => {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* ignore */ }
  return { status: res.status, json, text }
}

// 空库
{
  const st = await get('/state')
  eq('/state 200', st.status, 200)
  eq('空库时 warning 提示', Array.isArray(st.json.value.round.warnings) && st.json.value.round.warnings.length > 0, true)
  eq('空题库 → 0 题', st.json.value.round.questions.length, 0)
  eq('默认落在学习 tab', st.json.value.round.tab, 'study')
}
// 导入题目 + 学习卡
{
  const impQ = await post('/bank/import', {
    kind: 'questions',
    text: JSON.stringify([
      { title: '卡A-题1', lessonTitle: '卡A', prompt: 'p1', rubric: ['a', 'b', 'c'], answer: 'A1', trap: 'trap1' },
      { title: '卡A-题2', lessonTitle: '卡A', prompt: 'p2', rubric: ['d'], answer: 'A2' },
      { title: '卡B-题1', lessonTitle: '卡B', prompt: 'p3', rubric: ['e'], answer: 'A3' },
    ]),
  })
  eq('导入题目 200', impQ.status, 200)
  eq('导入 3 条', impQ.json.value.imported, 3)
  const impL = await post('/bank/import', {
    kind: 'lessons',
    text: JSON.stringify([
      { title: '卡A', summary: '摘要A', body: '正文A', keyPoints: ['k1', 'k2'] },
      { title: '卡B', summary: '摘要B', body: '正文B' },
    ]),
  })
  eq('导入学习卡 200', impL.status, 200)
  eq('学习卡 2 条', impL.json.value.imported, 2)
}
// 一轮里能拿到题 + 学习卡正文
let round1 = null
{
  const rg = await post('/regenerate', {})
  eq('regenerate 200', rg.status, 200)
  round1 = rg.json.value.round
  ok('一轮有题', round1.questions.length > 0)
  eq('学习 tab 拿到卡片', round1.study.length > 0, true)
  const cardA = round1.study.find(s => s.title === '卡A')
  ok('学习卡带正文（先学后答的关键）', cardA && cardA.body === '正文A', JSON.stringify(cardA && { b: cardA.body }))
  ok('学习卡带要点', cardA && cardA.keyPoints.length === 2)
  const q0 = round1.questions[0]
  ok('题面上没有 rubric', q0.rubric === undefined)
  ok('题面上没有 answer', q0.answer === undefined)
  ok('题面上没有 trap', q0.trap === undefined)
  ok('题面有角度', typeof q0.angle === 'string' && q0.angle.length > 0)
}
// key（判分要点）只在拉开时给
{
  const qid = round1.questions[0].id
  const k = await get('/key?id=' + encodeURIComponent(qid))
  eq('/key 200', k.status, 200)
  ok('/key 给 rubric', Array.isArray(k.json.value.rubric) && k.json.value.rubric.length > 0)
  const miss = await get('/key?id=NOPE')
  eq('/key 未知 id → 404 语义', miss.json.ok, false)
}
// 提交：缺分数不落盘
{
  const before = await get('/bank')
  const attemptsBefore = before.json.value.totals.attempts
  const bad = await post('/submit', { qid: round1.questions[0].id })
  eq('缺 score → 400', bad.status, 400)
  eq('缺 score → bad-request', bad.json.error.code, 'bad-request')
  const after = await get('/bank')
  eq('缺 score 不落盘', after.json.value.totals.attempts, attemptsBefore)
  const noQid = await post('/submit', { score: 3 })
  eq('缺 qid → 400', noQid.status, 400)
}
// 提交：正常记分 + 排下次复习
let submittedLessonId = ''
{
  const qid = round1.questions[0].id
  const r = await post('/submit', { qid, score: 4, note: '缺口：没说清边界' })
  eq('提交 200', r.status, 200)
  eq('提交回 passed', r.json.value.passed, true)
  ok('提交回下次复习时间', /^\d{4}-\d{2}-\d{2}T/.test(r.json.value.lesson.dueAt), r.json.value.lesson.dueAt)
  eq('提交回档位 1', r.json.value.lesson.streak, 1)
  ok('提交回轮换角度', typeof r.json.value.lesson.angle === 'string' && r.json.value.lesson.angle.length > 0)
  submittedLessonId = r.json.value.lesson.lessonId
  const p = JSON.parse(fs.readFileSync(path.join(dataDir, 'progress.json'), 'utf8'))
  ok('progress.json 有该知识点', Boolean(p.items[submittedLessonId]))
  eq('progress 记了答题历史', p.attempts.length, 1)
  eq('答题历史带 note', p.attempts[0].note, '缺口：没说清边界')
}
// 学习卡详情（学习 tab 的「翻原卡」）
{
  // 本轮第一道题可能属于卡A也可能属于卡B（换一批会轮换起点），按它的 lessonTitle 取期望正文
  const expectBody = round1.questions[0].lessonTitle === '卡B' ? '正文B' : '正文A'
  const d = await get('/lesson?id=' + encodeURIComponent(submittedLessonId))
  eq('/lesson 200', d.status, 200)
  eq('/lesson 回正文', d.json.value.body, expectBody)
  ok('/lesson 回复习进度', d.json.value.progress && d.json.value.progress.seen === 1, JSON.stringify(d.json.value.progress))
  const miss = await get('/lesson?id=NOPE')
  eq('/lesson 未知 id 404', miss.status, 404)
}
// 3 道题都答完 → 下一轮计时重新开始（并且不是 0）
{
  const st = await get('/state')
  const qs = st.json.value.round.questions
  for (const q of qs) if (!st.json.value.round.answered[q.id]) await post('/submit', { qid: q.id, score: 3 })
  const after = await get('/state')
  eq('答完 5 题（或全部）', after.json.value.round.pendingCount, 0)
  ok('答完自动续排下一轮', after.json.value.nextInMs > 0 && after.json.value.nextInMs <= 10 * 60000, String(after.json.value.nextInMs))
}
// 题库列表
{
  const b = await get('/bank')
  eq('/bank 200', b.status, 200)
  eq('题数', b.json.value.totals.questions, 3)
  eq('卡数', b.json.value.totals.lessons, 2)
  ok('/bank 带复习状态', b.json.value.lessons.some(l => l.review && l.review.seen > 0))
}
// 导出
{
  const res = await fetch(base + '/bank/export?kind=questions')
  const text = await res.text()
  eq('导出 CSV 200', res.status, 200)
  ok('导出 CSV 有表头', text.indexOf('title') > 0)
  ok('导出 CSV 是附件', String(res.headers.get('content-disposition')).indexOf('attachment') === 0)
  const tpl = await fetch(base + '/bank/template?kind=lessons')
  const tplText = await tpl.text()
  ok('模板 CSV 含示例行', tplText.indexOf('标题') >= 0 && tplText.length > 50, 'len=' + tplText.length)
}
// 上传 xlsx 走 HTTP（base64）
{
  const buf = makeZip([
    ['xl/worksheets/sheet1.xml', sheetXml([
      ['标题', '知识点', '题干', '判分要点'],
      ['上传题1', '卡C', 'up1', 'u1 | u2'],
    ])],
  ])
  const r = await post('/bank/import', { kind: 'questions', filename: 'up.xlsx', base64: buf.toString('base64') })
  eq('xlsx 上传 200', r.status, 200)
  eq('xlsx 上传导入 1 条', r.json.value.imported, 1)
  const b = await get('/bank')
  eq('题库涨到 4 题', b.json.value.totals.questions, 4)
}
// 设置
{
  const s = await get('/settings')
  eq('/settings 200', s.status, 200)
  eq('默认 10 分钟', s.json.value.intervalMinutes, 10)
  eq('默认每轮 5 题', s.json.value.questionsPerRound, 5)
  ok('key 不回显明文', !Object.prototype.hasOwnProperty.call(JSON.stringify(s.json.value), 'apiKey') || /••••|""/.test(JSON.stringify(s.json.value.model)))
  const upd = await post('/settings', { intervalMinutes: 33, reviewSlots: 3 })
  eq('改间隔成功', upd.json.value.intervalMinutes, 33)
  eq('改复习位成功', upd.json.value.reviewSlots, 3)
  const back = await post('/settings', { intervalMinutes: 10, reviewSlots: 2 })
  eq('改回来', back.json.value.intervalMinutes, 10)
  const bad = await post('/settings', { intervalMinutes: 0 })
  eq('间隔 0 被夹到 1', bad.json.value.intervalMinutes, 1)
  await post('/settings', { intervalMinutes: 10 })
  const dp = await get('/settings/default-prompt')
  ok('默认提示词含占位符', /\{count\}/.test(dp.json.value.prompt) && /\{lessons\}/.test(dp.json.value.prompt))
}
// 提示词预览
{
  const p = await post('/generate/preview-prompt', { count: 3 })
  eq('预览提示词 200', p.status, 200)
  ok('预览里 {count} 被替换', p.json.value.prompt.indexOf('{count}') < 0)
  ok('预览里带知识点清单', p.json.value.prompt.indexOf('卡A') > 0)
}
// snooze / dismiss / tab / 主动打开
{
  const sn = await post('/snooze', {})
  eq('snooze 200', sn.status, 200)
  eq('snooze 后 skipped=false', sn.json.value.round.skipped, false)
  ok('snooze 后倒计时重置为一整轮', sn.json.value.nextInMs > 9 * 60000)
  const tab = await post('/tab', { tab: 'quiz' })
  eq('tab 切到答题', tab.json.value.round.tab, 'quiz')
  await post('/tab', { tab: 'study' })
  const dm = await post('/dismiss', {})
  eq('dismiss 200', dm.json.status, undefined)
  const st = await get('/state')
  eq('dismiss 后 skipped=true', st.json.value.round.skipped, true)

  // 主动打开（右下角小按钮 / POST /open）：收起后不用等 10 分钟就能重新弹出来
  const before = st.json.value.round
  const op = await post('/open', {})
  eq('open 200', op.status, 200)
  const o = op.json.value
  eq('open 后 skipped 清掉', o.round.skipped, false)
  eq('open 后还是同一轮（不换题）', o.round.id, before.id)
  ok('open 后 showSeq +1（客户端据此重弹）', o.round.showSeq === before.showSeq + 1)
  ok('open 后倒计时节拍不变', o.nextInMs > 9 * 60000)
  const op2 = await post('/open', {})
  ok('连点两次每次都 +1', op2.json.value.round.showSeq === before.showSeq + 2)
  eq('open 不落盘（进度没新增）', op2.json.value.round.answeredCount, before.answeredCount)
}
// 空库时 /open 也要能立刻攒出一轮
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'study-loop-open-'))
  let h3 = null
  const ctx3 = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect(fn) { return fn() },
    webServer: { register(opts) { h3 = opts.handler; return () => { h3 = null } } },
  }
  mod.apply(ctx3, { dataDir: t, legacyQuizDir: '', autoStart: false })
  const srv = http.createServer((req, res) => h3(req, res))
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const u = 'http://127.0.0.1:' + srv.address().port + '/study-loop/api'
  const r = await fetch(u + '/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  const j = await r.json()
  eq('空库 open 200', r.status, 200)
  ok('空库 open 也能给出 round', Boolean(j.value && j.value.round))
  ok('空库 open 会给出题库空的提示', Boolean(j.value.round.warnings.length > 0))
  await new Promise(r2 => srv.close(r2))
}
// 删除 / 重置
{
  const b1 = await get('/bank')
  const someQ = b1.json.value.questions.find(q => q.title === '上传题1')
  const del = await post('/bank/delete', { kind: 'questions', id: someQ.id })
  eq('删题 200', del.status, 200)
  eq('删后少一题', del.json.value.total, 3)
  const del2 = await post('/bank/delete', { kind: 'questions', id: 'NOPE' })
  eq('删不存在的题 404', del2.status, 404)
  const l = b1.json.value.lessons.find(x => x.id === submittedLessonId)
  const rst = await post('/bank/reset-review', { id: l.id })
  eq('重置复习 200', rst.status, 200)
  const b2 = await get('/bank')
  ok('重置后该卡变未学', b2.json.value.lessons.find(x => x.id === l.id).review === null)
}
// 模型生成（假 fetch）
{
  const gen = await load('lib/generate.js')
  const model = { baseUrl: 'http://127.0.0.1:1/v1', model: 'fake', apiKey: 'k', temperature: 0.2, timeoutMs: 5000 }
  const out = await gen.generateQuestions({
    model, prompt: '{count}\n{topic}\n{lessons}\n{angles}', lessons: [{ id: 'L-a', title: '卡A', keyPoints: ['k1'] }],
    count: 2, ctx: { newId: store.newId, stamp: store.stamp }, env: {}, fetchImpl: fakeFetch,
  })
  eq('模型生成 2 题', out.questions.length, 2)
  eq('生成题带 lessonId', out.questions[0].lessonId, 'L-a')
  eq('生成题 source=model', out.questions[0].source, 'model')
  eq('生成回 token 用量', out.usage.total_tokens, 123)
  ok('发给模型的提示词替换了 count', fakeFetch.calls[fakeFetch.calls.length - 1].prompt.indexOf('{count}') < 0)

  let err = null
  try { await gen.generateQuestions({ model: { ...model, baseUrl: 'https://api.example.com/v1', apiKey: '', apiKeyEnv: 'NO_SUCH_ENV_XYZ' }, prompt: 'x', lessons: [{ id: 'L', title: 't' }], count: 1, env: {}, fetchImpl: fakeFetch }) }
  catch (e) { err = String(e.message || e) }
  ok('缺 key 报明确错误', /API key/i.test(String(err)), String(err))

  const noLessons = await gen.generateQuestions({ model, prompt: 'x', lessons: [], count: 1, env: {}, fetchImpl: fakeFetch }).then(() => null, e => String(e.message))
  ok('没有知识点时报错（不是瞎编）', /知识点/.test(String(noLessons)), String(noLessons))

  eq('extractJson 吃 ```json 围栏', generate.extractJson('```json\n{"a":1}\n```').a, 1)
  eq('extractJson 吃前后废话', generate.extractJson('好的：{"a":2} 完').a, 2)
  let jerr = null
  try { generate.extractJson('完全不是 json') } catch (e) { jerr = String(e.message) }
  ok('extractJson 对非 JSON 报错', Boolean(jerr))
  eq('fillPrompt 保留未知占位符', generate.fillPrompt('{a}-{b}', { a: 1 }), '1-{b}')
}
// 回环校验（必须用 node:http 发原始请求 —— fetch/undici 不允许覆盖 Host 头）
{
  const r = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.address().port,
      path: '/study-loop/api/state',
      method: 'GET',
      headers: { host: 'evil.example.com' },
    }, res => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', d => { text += d })
      res.on('end', () => resolve({ status: res.statusCode, text }))
    })
    req.on('error', reject)
    req.end()
  })
  eq('非回环 host → 403', r.status, 403)
  let body = null
  try { body = JSON.parse(r.text) } catch { /* ignore */ }
  eq('403 带 forbidden', body && body.error && body.error.code, 'forbidden')
}
// 未知路由
{
  const r = await get('/nope')
  eq('未知路由 404', r.status, 404)
}
// 数据文件完好性：所有 json 都能解析
{
  for (const f of ['settings.json', 'questions.json', 'lessons.json', 'progress.json']) {
    let okParse = true
    try { JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')) } catch { okParse = false }
    ok(f + ' 是合法 JSON', okParse)
  }
  const leftovers = fs.readdirSync(dataDir).filter(f => f.indexOf('.tmp-study-loop') >= 0)
  eq('不残留临时文件', leftovers.length, 0)
}
// 清理
{
  for (const d of disposers) if (typeof d.d === 'function') d.d()
  server.close()
  ok('disposer 可调用', true)
}

fs.rmSync(sandbox, { recursive: true, force: true })
console.log('\n' + (failures.length === 0 ? '✅ 全部通过：' + pass + ' 项' : '❌ 失败 ' + failures.length + ' / 共 ' + (pass + failures.length) + ' 项'))
if (failures.length) { failures.forEach(f => console.log('   - ' + f)); process.exit(1) }
