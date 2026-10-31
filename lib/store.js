// 存储层：所有落盘路径、原子读写、默认数据形状、ID 生成。
// 设计约束：
// - 零依赖（插件不装 npm 包），所有解析手写。
// - 每个文件独立原子写（写 .tmp 再 rename），单个文件坏掉不牵连其它文件。
// - 数据全在 dataDir 里，删这个目录 = 恢复出厂。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const FILES = {
  lessons: 'lessons.json',
  questions: 'questions.json',
  progress: 'progress.json',
  settings: 'settings.json',
}

export const ANGLES = ['原理', '反例', '应用', '对比', '排错', '边界', '类比', '取舍']

/** 默认数据目录：~/.dsh-study-loop */
export function defaultDataDir() {
  return path.join(os.homedir(), '.dsh-study-loop')
}

export function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

/** 不带毫秒的本地时间 ISO：dueAt 存成这个格式，人眼看得懂，前端 new Date() 也认。 */
export function isoLocal(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const ah = p(Math.floor(Math.abs(off) / 60))
  const am = p(Math.abs(off) % 60)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + sign + ah + ':' + am
}

export function parseTime(s) {
  if (!s) return 0
  const t = Date.parse(String(s).includes('T') ? String(s) : String(s).replace(' ', 'T'))
  return Number.isFinite(t) ? t : 0
}

/** 原子写：先写同目录 .tmp 再 rename，避免断电/并发留下半截 JSON。 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-study-loop'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

export function readJson(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return null
    throw err
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    // 坏文件必须指出是哪个文件、坏在哪，否则排障只能靠猜
    throw new Error('数据文件不是合法 JSON：' + file + '（' + (err && err.message) + '）开头：' + JSON.stringify(String(text).slice(0, 80)))
  }
}

export function emptyLessons() {
  return { version: 1, lessons: [] }
}
export function emptyQuestions() {
  return { version: 1, questions: [] }
}
export function emptyProgress() {
  return { version: 1, items: {}, attempts: [] }
}

export function defaultSettings() {
  return {
    version: 1,
    // 模型生成题目用：OpenAI 兼容的 chat/completions 端点
    model: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKey: '',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      temperature: 0.7,
      timeoutMs: 60000,
    },
    // 每次由模型生成题目时用的提示词（可用占位符 {count} {topic} {lessons} {angles}）
    prompt: [
      '你是出题人。下面是我正在学的知识点（每条形如「标题 :: 要点」）。',
      '请围绕这些知识点出 {count} 道题，用来检验我是否真的理解。',
      '要求：',
      '1. 只考「理解与因果」，不考死记硬背的名词解释；',
      '2. 每题给出 angle（提问角度，从这些里选：{angles}），并且尽量覆盖不同角度；',
      '3. 每题给 rubric（3-5 条判分要点，能据此打 0-5 分）；',
      '4. 严格输出 JSON，形如 {"questions":[{"title":"","angle":"","type":"","prompt":"","rubric":[""],"hint":"","answer":"","trap":"","lessonTitle":"对应上面的标题"}]}；',
      '5. 除 JSON 外不要输出任何文字。',
      '',
      '知识点：',
      '{lessons}',
    ].join('\n'),
    // 弹窗节奏
    intervalMinutes: 10,
    questionsPerRound: 5,
    reviewSlots: 2,
    passScore: 3,
    maxScore: 5,
  }
}

/** 合并默认设置（老版本 settings.json 缺字段时补上，不覆盖用户已填的）。 */
export function mergeSettings(saved) {
  const base = defaultSettings()
  if (!saved || typeof saved !== 'object') return base
  const out = { ...base, ...saved }
  out.model = { ...base.model, ...(saved.model && typeof saved.model === 'object' ? saved.model : {}) }
  if (!String(out.prompt || '').trim()) out.prompt = base.prompt
  // 0 是合法输入（要夹到下限），所以不能用 `|| base` 判空
  out.intervalMinutes = clampInt(out.intervalMinutes, 1, 7 * 24 * 60, base.intervalMinutes)
  out.questionsPerRound = clampInt(out.questionsPerRound, 1, 20, base.questionsPerRound)
  out.reviewSlots = clampInt(out.reviewSlots, 0, out.questionsPerRound, 0)
  out.passScore = clampInt(out.passScore, 1, 5, base.passScore)
  out.maxScore = 5
  return out
}

/** 取整数并夹到 [min,max]；非数字才回退 fallback（0 不会被当成"没填"）。 */
function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

let idCounter = 0
/** 短 id：前缀 + 时间base36 + 序号，人眼能排序、不用 uuid 依赖。 */
export function newId(prefix) {
  idCounter += 1
  return prefix + Date.now().toString(36) + '-' + idCounter.toString(36)
}

/** 把任意输入归一成字符串数组（rubric/keyPoints 常见来源：数组、换行文本、逗号文本）。 */
export function toStringList(value) {
  if (Array.isArray(value)) return value.map(v => String(v == null ? '' : v).trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value.split(/\r?\n/).map(s => s.replace(/^\s*[-*·]\s*/, '').trim()).filter(Boolean)
  }
  return []
}
