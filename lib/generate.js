// 模型生成题目：走 OpenAI 兼容的 /chat/completions（DeepSeek / Ollama / 任何兼容端）。
// 设计取舍：
// - 不用 SDK，node 自带 fetch 足够，插件零依赖。
// - key 优先读环境变量（settings.model.apiKeyEnv），settings 里存的 key 只在本机文件，不上传。
// - 模型返回必须是 JSON；先从 ```json 围栏里抠，再退化成「找第一个 { 到最后一个 }」。
import { normalizeQuestion, ANGLES } from './review.js'

/** 把知识点拼成给模型看的清单文本。 */
export function lessonsBrief(lessons, limit = 40) {
  const rows = []
  for (const l of lessons.slice(0, limit)) {
    const points = (l.keyPoints || []).join('；')
    const body = String(l.body || '').replace(/\s+/g, ' ').slice(0, 200)
    rows.push('- ' + l.title + (points || body ? ' :: ' + [points, body].filter(Boolean).join(' | ') : ''))
  }
  return rows.join('\n')
}

/** 填提示词占位符。没提供的占位符原样留着，用户能看出漏了什么。 */
export function fillPrompt(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (m, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : m
  })
}

/** 从模型回复里抽出 JSON（容忍 ```json 围栏、前后废话）。 */
export function extractJson(text) {
  const s = String(text || '').trim()
  if (!s) throw new Error('模型没返回内容')
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s)
  const candidates = []
  if (fence) candidates.push(fence[1].trim())
  candidates.push(s)
  const firstBrace = s.indexOf('{')
  const firstBracket = s.indexOf('[')
  const starts = [firstBrace, firstBracket].filter(i => i >= 0)
  if (starts.length) {
    const start = Math.min.apply(null, starts)
    const lastBrace = s.lastIndexOf('}')
    const lastBracket = s.lastIndexOf(']')
    const end = Math.max(lastBrace, lastBracket)
    if (end > start) candidates.push(s.slice(start, end + 1))
  }
  for (const c of candidates) {
    try { return JSON.parse(c) } catch { /* 试下一个 */ }
  }
  throw new Error('模型返回的不是 JSON：' + s.slice(0, 200))
}

function pickKey(model, env) {
  const fromEnv = model && model.apiKeyEnv ? env[model.apiKeyEnv] : ''
  if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim()
  const fromFile = model && model.apiKey ? String(model.apiKey).trim() : ''
  if (fromFile) return fromFile
  return ''
}

function isLocalUrl(baseUrl) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|$|\/)/i.test(String(baseUrl || ''))
}

/**
 * 调模型生成题目。
 * @param {object} opts { model, prompt, lessons, count, fetchImpl?, env? }
 * @returns {Promise<{questions: object[], raw: string, warnings: string[]}>}
 */
export async function generateQuestions(opts) {
  const model = (opts && opts.model) || {}
  const env = (opts && opts.env) || (typeof process !== 'undefined' && process.env) || {}
  const fetchImpl = (opts && opts.fetchImpl) || (typeof fetch === 'function' ? fetch : null)
  const warnings = []
  if (!fetchImpl) throw new Error('当前运行时没有 fetch，无法调用模型')

  const baseUrl = String(model.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const modelName = String(model.model || 'deepseek-chat').trim()
  const count = Math.max(1, Math.min(20, Number(opts && opts.count) || 5))
  const lessons = (opts && opts.lessons) || []
  if (lessons.length === 0) throw new Error('还没有知识点，先在学习页加一条，或用 Excel/JSON 导入')

  const template = String(opts && opts.prompt ? opts.prompt : '')
  const content = fillPrompt(template, {
    count,
    topic: (opts && opts.topic) ? String(opts.topic) : lessons.map(l => l.title).join('、'),
    lessons: lessonsBrief(lessons),
    angles: ANGLES.join(' / '),
  })

  const key = pickKey(model, env)
  if (!key && !isLocalUrl(baseUrl)) {
    throw new Error('缺 API key：设环境变量 ' + (model.apiKeyEnv || 'DEEPSEEK_API_KEY') + '，或在设置里填 key')
  }

  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: '你是严谨的出题人。只输出 JSON，不要解释。' },
      { role: 'user', content },
    ],
    temperature: Number.isFinite(Number(model.temperature)) ? Number(model.temperature) : 0.7,
    stream: false,
  }
  // 部分端点不认识 response_format，加上它更稳；失败会走下面的重试
  body.response_format = { type: 'json_object' }

  const url = /\/chat\/completions$/.test(baseUrl) ? baseUrl : baseUrl + '/chat/completions'
  const headers = { 'content-type': 'application/json' }
  if (key) headers.authorization = 'Bearer ' + key

  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timeoutMs = Math.max(5000, Number(model.timeoutMs) || 60000)
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null
  let res
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller ? controller.signal : undefined,
    })
  } catch (err) {
    if (timer) clearTimeout(timer)
    const msg = String((err && err.message) || err)
    if (/abort/i.test(msg)) throw new Error('模型请求超时（' + timeoutMs + 'ms）')
    throw new Error('模型请求失败：' + msg)
  }
  if (timer) clearTimeout(timer)

  const text = await res.text()
  if (!res.ok) {
    // response_format 不被支持时，去掉再试一次
    if (res.status === 400 && /response_format/i.test(text)) {
      warnings.push('该端点不支持 response_format，已去掉重试')
      delete body.response_format
      const retry = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) })
      const retryText = await retry.text()
      if (!retry.ok) throw new Error('模型返回 ' + retry.status + '：' + retryText.slice(0, 300))
      return parseGenerated(retryText, warnings, opts)
    }
    throw new Error('模型返回 ' + res.status + '：' + text.slice(0, 300))
  }
  return parseGenerated(text, warnings, opts)
}

function parseGenerated(responseText, warnings, opts) {
  let payload
  try { payload = JSON.parse(responseText) } catch {
    throw new Error('模型响应不是 JSON：' + String(responseText).slice(0, 200))
  }
  const choice = payload && payload.choices && payload.choices[0]
  const content = choice && choice.message ? (choice.message.content || '') : ''
  if (!String(content).trim()) throw new Error('模型返回了空内容')
  const data = extractJson(content)
  let list = []
  if (Array.isArray(data)) list = data
  else if (data && Array.isArray(data.questions)) list = data.questions
  else if (data && typeof data === 'object' && (data.title || data.prompt)) list = [data]
  else throw new Error('模型返回的 JSON 里没有 questions 数组')

  const ctx = (opts && opts.ctx) || {}
  const lessons = (opts && opts.lessons) || []
  const byTitle = {}
  for (const l of lessons) byTitle[String(l.title).trim()] = l

  const questions = []
  for (const raw of list) {
    const obj = raw && typeof raw === 'object' ? { ...raw } : null
    if (!obj) continue
    // 模型常把知识点标题写在 lessonTitle；找不到就退化成第一条
    if (!obj.lessonTitle && !obj.lessonId && lessons.length === 1) obj.lessonTitle = lessons[0].title
    const rec = normalizeQuestion(obj, ctx)
    if (!rec) { warnings.push('生成的一条缺标题，跳过'); continue }
    const hit = byTitle[String(rec.lessonTitle || '').trim()]
    if (hit) {
      rec.lessonId = hit.id
      rec.lessonTitle = hit.title
    } else if (lessons.length === 1) {
      rec.lessonId = lessons[0].id
      rec.lessonTitle = lessons[0].title
    }
    rec.source = 'model'
    questions.push(rec)
  }
  if (questions.length === 0) throw new Error('模型没给出可用的题（缺标题）')
  const usage = payload && payload.usage ? payload.usage : null
  return { questions, warnings, usage }
}

/**
 * 模型生成一张学习卡（用户手头只有标题、需要先有内容可学）。
 */
export async function generateLesson(opts) {
  const model = (opts && opts.model) || {}
  const env = (opts && opts.env) || (typeof process !== 'undefined' && process.env) || {}
  const fetchImpl = (opts && opts.fetchImpl) || (typeof fetch === 'function' ? fetch : null)
  const topic = String((opts && opts.topic) || '').trim()
  if (!topic) throw new Error('要给一个知识点标题')
  if (!fetchImpl) throw new Error('当前运行时没有 fetch，无法调用模型')
  const baseUrl = String(model.baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '')
  const key = pickKey(model, env)
  if (!key && !isLocalUrl(baseUrl)) {
    throw new Error('缺 API key：设环境变量 ' + (model.apiKeyEnv || 'DEEPSEEK_API_KEY') + '，或在设置里填 key')
  }
  const url = /\/chat\/completions$/.test(baseUrl) ? baseUrl : baseUrl + '/chat/completions'
  const prompt = [
    '请给我讲清楚这个知识点：「' + topic + '」。',
    '输出 JSON，形如 {"title":"","summary":"一句话说清它是什么","body":"300-600 字的讲解，讲因果和机制","keyPoints":["3-5 条要点"]}。',
    '不要输出 JSON 以外的任何文字。',
  ].join('\n')
  const headers = { 'content-type': 'application/json' }
  if (key) headers.authorization = 'Bearer ' + key
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: String(model.model || 'deepseek-chat'),
      messages: [
        { role: 'system', content: '你是耐心的老师。只输出 JSON。' },
        { role: 'user', content: prompt },
      ],
      temperature: Number.isFinite(Number(model.temperature)) ? Number(model.temperature) : 0.7,
      stream: false,
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error('模型返回 ' + res.status + '：' + text.slice(0, 300))
  const payload = JSON.parse(text)
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content : ''
  const data = extractJson(content)
  return {
    title: String(data.title || topic).trim(),
    summary: String(data.summary || '').trim(),
    body: String(data.body || '').trim(),
    keyPoints: Array.isArray(data.keyPoints) ? data.keyPoints.map(String) : [],
  }
}
