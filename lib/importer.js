// 题库导入 / 导出：CSV、TSV、Excel(.xlsx) 读取，CSV 导出，以及把 JSON 字符串归一成题。
// 为什么手写 xlsx 解析：插件零依赖，用户装插件不该顺带拉一堆 npm 包。
// xlsx 本质是 zip，node 自带 zlib 能 inflateRaw，所以只差一个中央目录扫描器。
import zlib from 'node:zlib'
import { normalizeQuestion, normalizeLesson } from './review.js'

// ------------------------------------------------------------------ CSV / TSV

/** 一个够用的 CSV 解析器：支持引号包裹、双引号转义、字段内换行。*/
export function parseDelimited(text, delimiter) {
  const sep = delimiter || (String(text).indexOf('\t') >= 0 && String(text).indexOf(',') < 0 ? '\t' : ',')
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const s = String(text || '').replace(/^\uFEFF/, '')
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1 }
        else inQuotes = false
      } else field += c
      continue
    }
    if (c === '"') { inQuotes = true; continue }
    if (c === sep) { row.push(field); field = ''; continue }
    if (c === '\r') continue
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += c
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter(r => r.some(c => String(c).trim() !== ''))
}

function toCsv(rows) {
  const esc = v => {
    const s = v == null ? '' : String(v)
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  // 带 BOM：Excel 打开中文不乱码
  return '\uFEFF' + rows.map(r => r.map(esc).join(',')).join('\r\n') + '\r\n'
}

// ------------------------------------------------------------------ xlsx（zip）

const SIG_EOCD = 0x06054b50
const SIG_CEN = 0x02014b50
const SIG_LOC = 0x04034b50

/** 扫 zip 中央目录，返回 { 文件名: Buffer }（只解出调用方要的条目）。 */
export function unzip(buf, wanted) {
  const out = {}
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 中央目录）')
  const total = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < total; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (wanted && wanted.length && !wanted.some(w => name === w || name.startsWith(w))) continue
    if (buf.readUInt32LE(localOff) !== SIG_LOC) continue
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    try {
      out[name] = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw)
    } catch {
      // 个别条目解压失败就当它不存在，别让整个导入失败
    }
  }
  return out
}

function xmlText(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

function parseSharedStrings(xml) {
  const list = []
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const parts = []
    const tre = /<t\b[^>]*>([\s\S]*?)<\/t>/g
    let t
    while ((t = tre.exec(m[1])) !== null) parts.push(xmlText(t[1]))
    list.push(parts.join(''))
  }
  return list
}

/** 列号 A→0、AB→27。 */
function colIndex(ref) {
  const letters = String(ref).replace(/[^A-Za-z]/g, '').toUpperCase()
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return Math.max(0, n - 1)
}

/** 读第一张工作表 → 二维字符串数组。 */
export function readXlsx(buf) {
  const files = unzip(buf, ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet.xml', 'xl/worksheets/'])
  const sheetKey = Object.keys(files).find(k => /^xl\/worksheets\/[^/]*sheet[^/]*\.xml$/.test(k)) ||
    Object.keys(files).find(k => k.startsWith('xl/worksheets/'))
  if (!sheetKey) throw new Error('xlsx 里找不到工作表')
  const shared = files['xl/sharedStrings.xml'] ? parseSharedStrings(files['xl/sharedStrings.xml'].toString('utf8')) : []
  const sheetXml = files[sheetKey].toString('utf8')
  const rows = []
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g
  let rm
  while ((rm = rowRe.exec(sheetXml)) !== null) {
    const cells = []
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g
    let cm
    while ((cm = cellRe.exec(rm[1])) !== null) {
      const attrs = cm[1] || ''
      const inner = cm[2] || ''
      const refM = /r="([A-Za-z]+\d+)"/.exec(attrs)
      const idx = refM ? colIndex(refM[1]) : cells.length
      const typeM = /\bt="([^"]+)"/.exec(attrs)
      const type = typeM ? typeM[1] : ''
      let value = ''
      if (type === 's') {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner)
        value = vm ? (shared[Number(vm[1])] || '') : ''
      } else if (type === 'inlineStr') {
        const tm = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(inner)
        value = tm ? xmlText(tm[1]) : ''
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner)
        value = vm ? xmlText(vm[1]) : ''
      }
      while (cells.length < idx) cells.push('')
      cells[idx] = value
    }
    if (cells.some(c => String(c).trim() !== '')) rows.push(cells)
  }
  return rows
}

// ------------------------------------------------------------------ 表 → 记录

/**
 * 表头别名表：中英混写都能认。
 * 按 kind 分开是有原因的：「知识点」在题目表里指所属学习卡，在学习卡表里指的就是标题本身；
 * 「要点」在题目表里是判分要点，在学习卡表里是关键要点。共用一张表会互相抢列。
 */
const ALIASES_QUESTIONS = {
  id: ['id', '编号'],
  title: ['title', '标题', '题目', '题名', 'name'],
  lessonTitle: ['lessontitle', '知识点', '知识点标题', '所属知识点', 'knowledge', 'lesson'],
  prompt: ['prompt', '题干', '问题', 'question', '题目内容', '问法'],
  reviewPrompt: ['reviewprompt', '复习问法', '换角度问法', 'review'],
  rubric: ['rubric', '判分要点', '评分要点', '要点', 'keypoints', 'keys'],
  hint: ['hint', '提示', '小提示'],
  answer: ['answer', '参考答案', '答案', 'reference'],
  trap: ['trap', '常见错法', '易错', '误区', 'pitfall'],
  type: ['type', '类型', '题型'],
  angle: ['angle', '角度', '提问角度'],
}

const ALIASES_LESSONS = {
  id: ['id', '编号'],
  title: ['title', '标题', '知识点', '知识点标题', '主题', 'name'],
  summary: ['summary', '摘要', '一句话', '简述'],
  body: ['body', '内容', '正文', '讲解', '详细'],
  keyPoints: ['keypoints', '要点', '关键要点', '主要要点', 'keys', 'points'],
  tags: ['tags', '标签', '分类'],
}

function normHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/[\s_\-()（）]/g, '')
}

/** 表头行 → { 列索引: 规范字段名 }。同一字段只认第一列命中（避免两列抢同一个字段）。 */
function mapHeaders(headerRow, kind) {
  const aliases = kind === 'lessons' ? ALIASES_LESSONS : ALIASES_QUESTIONS
  const map = {}
  const taken = new Set()
  headerRow.forEach((h, i) => {
    const key = normHeader(h)
    if (!key) return
    for (const field of Object.keys(aliases)) {
      if (taken.has(field)) continue
      if (aliases[field].some(a => normHeader(a) === key)) {
        map[i] = field
        taken.add(field)
        return
      }
    }
  })
  return map
}

const LIST_FIELDS = new Set(['rubric', 'tags', 'keyPoints'])

/**
 * 二维表 → 记录数组。列表字段（rubric/tags）允许用 `|`、`；`、换行分隔。
 * @param {string[][]} rows
 * @param {'questions'|'lessons'} kind
 * @param {object} ctx { newId, stamp }
 */
export function rowsToRecords(rows, kind, ctx) {
  const warnings = []
  if (!rows || rows.length < 2) {
    if (!rows || rows.length === 0) warnings.push('表是空的')
    else warnings.push('只有表头没有数据行')
    return { records: [], warnings }
  }
  const map = mapHeaders(rows[0], kind)
  if (Object.keys(map).length === 0) {
    warnings.push('表头没认出来：至少要有「标题」或「title」这一列')
    return { records: [], warnings }
  }
  const records = []
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] || []
    const obj = {}
    for (const idx of Object.keys(map)) {
      const field = map[idx]
      const cellText = String(row[Number(idx)] == null ? '' : row[Number(idx)]).trim()
      if (!cellText) continue
      if (LIST_FIELDS.has(field)) {
        obj[field] = cellText.split(/[|\n；;]+/).map(s => s.trim()).filter(Boolean)
      } else obj[field] = cellText
    }
    if (!obj.title && !obj.prompt) { warnings.push('第 ' + (r + 1) + ' 行没有标题，跳过'); continue }
    if (!obj.title) obj.title = obj.prompt
    const rec = kind === 'lessons' ? normalizeLesson(obj, ctx) : normalizeQuestion(obj, ctx)
    if (rec) records.push(rec)
    else warnings.push('第 ' + (r + 1) + ' 行归一化失败，跳过')
  }
  return { records, warnings }
}

/** 从上传的文件字节里抽记录：按扩展名/内容判断是 xlsx 还是 csv/tsv。 */
export function recordsFromFile(buf, filename, kind, ctx) {
  const lower = String(filename || '').toLowerCase()
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === SIG_LOC
  if (isZip || lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    return rowsToRecords(readXlsx(buf), kind, ctx)
  }
  if (lower.endsWith('.xls')) {
    throw new Error('老式 .xls 不支持，请在 Excel 里另存为 .xlsx 或 CSV')
  }
  const text = buf.toString('utf8')
  return rowsToRecords(parseDelimited(text), kind, ctx)
}

// ------------------------------------------------------------------ 导出

export function questionsToCsv(questions) {
  const head = ['id', 'title', 'lessonTitle', 'type', 'angle', 'prompt', 'rubric', 'hint', 'answer', 'trap', 'reviewPrompt', 'source']
  const rows = [head]
  for (const q of questions) {
    rows.push([
      q.id, q.title, q.lessonTitle, q.type, q.angle, q.prompt,
      (q.rubric || []).join(' | '), q.hint, q.answer, q.trap, q.reviewPrompt, q.source,
    ])
  }
  return toCsv(rows)
}

export function lessonsToCsv(lessons) {
  const head = ['id', 'title', 'summary', 'body', 'keyPoints', 'tags']
  const rows = [head]
  for (const l of lessons) {
    rows.push([l.id, l.title, l.summary, l.body, (l.keyPoints || []).join(' | '), (l.tags || []).join(' | ')])
  }
  return toCsv(rows)
}

export function progressToCsv(progress, questions) {
  const byLesson = {}
  for (const q of questions) {
    if (!q.lessonId) continue
    byLesson[q.lessonId] = byLesson[q.lessonId] || q.lessonTitle || ''
  }
  const head = ['lessonId', '知识点', '已见次数', '最近得分', '连对档位', '下次复习', '当前角度']
  const rows = [head]
  const items = (progress && progress.items) || {}
  for (const id of Object.keys(items)) {
    const it = items[id] || {}
    rows.push([id, byLesson[id] || '', it.seen || 0, it.lastScore == null ? '' : it.lastScore, it.streak || 0, it.dueAt || '', it.angle || ''])
  }
  return toCsv(rows)
}

// ------------------------------------------------------------------ JSON 文本

/** 用户粘贴的一段 JSON：能是数组、{questions:[]}、{lessons:[]}、或单条对象。 */
export function recordsFromJsonText(text, kind, ctx) {
  const warnings = []
  const raw = String(text || '').trim()
  if (!raw) return { records: [], warnings: ['内容为空'] }
  let data
  try {
    data = JSON.parse(raw)
  } catch (err) {
    return { records: [], warnings: ['JSON 解析失败：' + (err && err.message)] }
  }
  let list = []
  if (Array.isArray(data)) list = data
  else if (data && Array.isArray(data[kind])) list = data[kind]
  else if (data && Array.isArray(data.questions)) list = data.questions
  else if (data && Array.isArray(data.lessons)) list = data.lessons
  else if (data && typeof data === 'object') list = [data]
  else return { records: [], warnings: ['JSON 结构不认识：要数组或 {questions:[...]} / {lessons:[...]}'] }
  const records = []
  for (let i = 0; i < list.length; i += 1) {
    const rec = kind === 'lessons' ? normalizeLesson(list[i], ctx) : normalizeQuestion(list[i], ctx)
    if (rec) records.push(rec)
    else warnings.push('第 ' + (i + 1) + ' 条缺标题，跳过')
  }
  if (records.length === 0 && warnings.length === 0) warnings.push('没有任何有效记录')
  return { records, warnings }
}
