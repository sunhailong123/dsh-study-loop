// dsh-study-loop — 宿主端。
// 四件事：①把「知识点（学习卡）+ 题目」当数据管起来；②按间隔重复排一轮「先学后答」；
// ③落盘答题记录；④回环 HTTP API 给浮层用（题目管理 / 导入导出 / 模型生成也走这套 API）。
// 设计约束：
// - 零依赖，纯 node 内置模块。
// - 判分是自评（0-5），宿主只负责记录；rubric/answer 只在提交后发放，答题前不给。
// - 每个文件独立原子写，坏一个不牵连其它。
import fs from 'node:fs'
import path from 'node:path'
import {
  FILES, defaultDataDir, stamp, isoLocal, parseTime, writeJson, readJson,
  emptyLessons, emptyQuestions, emptyProgress, defaultSettings, mergeSettings, newId, toStringList,
} from './store.js'
import {
  composeRound, studentView, nextReview, normalizeQuestion, normalizeLesson,
  isDue, dueInMinutes, ANGLES, LADDER,
} from './review.js'
import { recordsFromFile, recordsFromJsonText, parseDelimited, rowsToRecords, questionsToCsv, lessonsToCsv, progressToCsv } from './importer.js'
import { generateQuestions, generateLesson, lessonsBrief, fillPrompt } from './generate.js'

export const name = 'study-loop'
export const inject = ['webServer']

const API_PREFIX = '/study-loop/api'
const MAX_BODY = 8 * 1024 * 1024 // 导入 Excel 会大一些

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const dataDir = cfg.dataDir ? String(cfg.dataDir) : defaultDataDir()
  // null = 没配（首次启动自动找 quiz-dojo 播种）；'' = 明确不要播种；其它 = 只用这一个目录
  const legacyQuizDir = cfg.legacyQuizDir === undefined ? null : String(cfg.legacyQuizDir)
  const fileOf = key => path.join(dataDir, FILES[key])

  const log = msg => { try { ctx.logger?.info?.('[study-loop] ' + msg) } catch { /* ignore */ } }

  // ---------------------------------------------------------------- 数据访问
  function settings() {
    return mergeSettings(readJson(fileOf('settings')))
  }
  function saveSettings(next) {
    writeJson(fileOf('settings'), mergeSettings(next))
  }
  function questions() {
    const d = readJson(fileOf('questions'))
    return d && Array.isArray(d.questions) ? d.questions : []
  }
  function lessons() {
    const d = readJson(fileOf('lessons'))
    return d && Array.isArray(d.lessons) ? d.lessons : []
  }
  function progress() {
    const d = readJson(fileOf('progress'))
    if (!d || typeof d !== 'object') return emptyProgress()
    if (!d.items || typeof d.items !== 'object') d.items = {}
    if (!Array.isArray(d.attempts)) d.attempts = []
    return d
  }
  const idCtx = { newId, stamp }

  function saveQuestions(list) { writeJson(fileOf('questions'), { version: 1, questions: list }) }
  function saveLessons(list) { writeJson(fileOf('lessons'), { version: 1, lessons: list }) }
  function saveProgress(p) {
    // 历史最多留 2000 条，防止文件无限长
    if (p.attempts.length > 2000) p.attempts = p.attempts.slice(-2000)
    writeJson(fileOf('progress'), p)
  }

  // ---------------------------------------------------------------- 首次启动：从旧题库播种
  // 从 dsh-quiz-popup / quiz-dojo 的 bank/w*.json 播种（answer 当学习卡正文，trap 当易错点）。
  // 只在 questions.json 不存在时才做，绝不覆盖用户已有数据。
  function seedFromLegacy() {
    if (fs.existsSync(fileOf('questions'))) return
    // 显式传 legacyQuizDir: '' 表示不播种（自测就靠这个隔离真实题库）
    if (legacyQuizDir === '') return
    const dirs = legacyQuizDir === null
      ? [path.join('D:', 'LLM学习', 'quiz-dojo'), path.join(require_home(), 'quiz-dojo')]
      : [legacyQuizDir]
    for (const dir of dirs) {
      const bankDir = path.join(dir, 'bank')
      let files = []
      try { files = fs.readdirSync(bankDir).filter(f => /^w\d+\.json$/i.test(f)) } catch { continue }
      if (files.length === 0) continue
      const qs = []
      const ls = []
      for (const file of files) {
        let data
        try { data = JSON.parse(fs.readFileSync(path.join(bankDir, file), 'utf8')) } catch { continue }
        if (!data || !Array.isArray(data.questions)) continue
        for (const q of data.questions) {
          const lessonTitle = String(q.title || '').trim()
          const lesson = normalizeLesson({
            id: 'L-' + String(q.id || '').toLowerCase(),
            title: lessonTitle,
            summary: String(q.prompt || '').split('\n')[0].slice(0, 80),
            body: [String(q.answer || ''), q.trap ? '常见错法：' + String(q.trap) : ''].filter(Boolean).join('\n\n'),
            keyPoints: toStringList(q.rubric).slice(0, 3),
            tags: ['week' + String(data.week || ''), String(q.type || '')],
          }, idCtx)
          if (lesson) ls.push(lesson)
          const rec = normalizeQuestion({
            id: q.id,
            lessonId: lesson ? lesson.id : '',
            lessonTitle,
            title: lessonTitle,
            prompt: q.prompt,
            rubric: q.rubric,
            hint: q.hint,
            answer: q.answer,
            trap: q.trap,
            type: q.type,
            angle: ANGLES[0],
            source: 'seed',
          }, idCtx)
          if (rec) qs.push(rec)
        }
      }
      if (qs.length === 0) continue
      saveQuestions(qs)
      if (!fs.existsSync(fileOf('lessons'))) saveLessons(ls)
      log('从旧题库播种 ' + qs.length + ' 道题 / ' + ls.length + ' 张学习卡（来源 ' + bankDir + '）')
      return
    }
  }

  function require_home() {
    try { return path.join(process.env.USERPROFILE || process.env.HOME || '', '') } catch { return '' }
  }

  // ---------------------------------------------------------------- 轮次
  let round = null
  let nextRoundAt = 0
  let seq = 0

  function composeOnce() {
    const s = settings()
    const warnings = []
    const now = Date.now()
    seq += 1
    const composed = composeRound({
      questions: questions(),
      progress: progress(),
      perRound: s.questionsPerRound,
      reviewSlots: s.reviewSlots,
      now,
      offset: (seq - 1) * s.questionsPerRound,
      warnings,
    })
    const lessonMap = {}
    for (const l of lessons()) lessonMap[l.id] = l
    // 学习 tab 的内容：新知识点给全文；复习题只给标题（否则等于把答案又发一遍）
    const study = []
    const seenLesson = new Set()
    for (const q of composed.questions) {
      const key = q.lessonId || q.title
      if (seenLesson.has(key)) continue
      seenLesson.add(key)
      const lesson = lessonMap[q.lessonId]
      const isReview = !!q.isReview
      study.push({
        id: q.lessonId || '',
        title: (lesson && lesson.title) || q.lessonTitle || q.title,
        angle: q.angle || '',
        isReview,
        summary: isReview ? '' : ((lesson && lesson.summary) || ''),
        body: isReview ? '' : ((lesson && lesson.body) || ''),
        keyPoints: isReview ? [] : ((lesson && lesson.keyPoints) || []),
        tags: isReview ? [] : ((lesson && lesson.tags) || []),
        hasCard: !!lesson,
        dueLabel: q.dueLabel || '',
        questionIds: composed.questions.filter(x => (x.lessonId || x.title) === key).map(x => x.id),
      })
    }
    return {
      round: {
        id: 'r' + now + '-' + seq,
        askedAt: stamp(),
        tab: 'study', // 默认落在学习 tab
        questions: composed.questions.map(studentView),
        study,
        answered: {},
        showSeq: 1,
        snoozeUntil: 0,
        skipped: false,
        warnings,
        passScore: s.passScore,
        maxScore: s.maxScore,
      },
      warnings,
    }
  }

  function armNext(now) {
    nextRoundAt = now + settings().intervalMinutes * 60 * 1000
  }

  function tick(now) {
    if (nextRoundAt === 0) {
      if (!round) { round = composeOnce().round; armNext(now) }
      return
    }
    if (now < nextRoundAt) return
    if (round !== null && round.snoozeUntil && now >= round.snoozeUntil) {
      round.snoozeUntil = 0
      round.showSeq += 1
      armNext(now)
      log('延后到点，重弹本轮 ' + round.questions.length + ' 题')
      return
    }
    if (round !== null && !round.skipped) {
      const pending = round.questions.filter(q => !round.answered[q.id]).length
      if (pending > 0) { armNext(now); return }
    }
    round = composeOnce().round
    armNext(now)
    log('新一轮到点：' + round.questions.length + ' 题（含复习 ' + round.study.filter(s => s.isReview).length + ' 个知识点）')
  }

  function publicSettings() {
    const s = settings()
    const env = (typeof process !== 'undefined' && process.env) || {}
    const envKey = s.model.apiKeyEnv ? Boolean(env[s.model.apiKeyEnv]) : false
    return {
      ...s,
      model: {
        ...s.model,
        apiKey: s.model.apiKey ? '••••' + String(s.model.apiKey).slice(-4) : '',
        hasKey: Boolean(s.model.apiKey) || envKey,
        keyFromEnv: envKey,
      },
      dataDir,
      ladder: LADDER,
      angles: ANGLES,
    }
  }

  function state() {
    const now = Date.now()
    const s = settings()
    const warns = round ? round.warnings.slice() : []
    const value = {
      round: null,
      nextInMs: Math.max(0, nextRoundAt - now),
      intervalMinutes: s.intervalMinutes,
      passScore: s.passScore,
      maxScore: s.maxScore,
      questionsPerRound: s.questionsPerRound,
      reviewSlots: s.reviewSlots,
      dataDir,
      warnings: warns,
    }
    if (round === null) return { ok: true, value }
    const answeredCount = Object.keys(round.answered).length
    value.round = {
      id: round.id,
      askedAt: round.askedAt,
      tab: round.tab,
      questions: round.questions,
      study: round.study,
      answered: round.answered,
      answeredCount,
      pendingCount: round.questions.length - answeredCount,
      showSeq: round.showSeq,
      skipped: round.skipped,
      warnings: round.warnings,
    }
    return { ok: true, value }
  }

  /** 学习卡详情（点了学习 tab 里的「展开」才会要正文以外的信息）。 */
  function lessonDetail(id) {
    const l = lessons().find(x => x.id === id)
    if (!l) return { ok: false, error: { code: 'not-found', message: '没有这个知识点：' + id } }
    const p = progress()
    const item = p.items[id] || null
    return {
      ok: true,
      value: {
        ...l,
        progress: item ? { ...item, dueInMinutes: dueInMinutes(item, Date.now()), due: isDue(item, Date.now()) } : null,
      },
    }
  }

  function keyOf(qid) {
    const q = questions().find(x => String(x.id).toUpperCase() === String(qid).toUpperCase())
    if (!q) return { ok: false, error: { code: 'not-found', message: '题库里没有 ' + qid } }
    const l = lessons().find(x => x.id === q.lessonId)
    return {
      ok: true,
      value: {
        id: q.id,
        title: q.title,
        rubric: q.rubric || [],
        answer: q.answer || '',
        trap: q.trap || '',
        angle: q.angle || '',
        lesson: l ? { id: l.id, title: l.title, body: l.body, keyPoints: l.keyPoints || [] } : null,
      },
    }
  }

  /**
   * 记一次自评。分数必须显式给（缺分数不落盘，避免顺手记成 0 分污染调度）。
   */
  function submit(qidRaw, scoreRaw, noteRaw) {
    const qid = String(qidRaw || '').trim()
    if (!qid) return { ok: false, error: { code: 'bad-request', message: 'qid 必填' } }
    const raw = (scoreRaw === null || scoreRaw === undefined || scoreRaw === '') ? NaN : Number(scoreRaw)
    if (!Number.isFinite(raw)) {
      const s = settings()
      return { ok: false, error: { code: 'bad-request', message: 'score 必填（0-' + s.maxScore + ' 整数），不给分数不落盘' } }
    }
    const s = settings()
    const score = Math.max(0, Math.min(s.maxScore, Math.round(raw)))
    const note = String(noteRaw || '').trim()
    const q = questions().find(x => String(x.id).toUpperCase() === qid.toUpperCase())
    if (!q) return { ok: false, error: { code: 'not-found', message: '题库里没有 ' + qid } }

    const p = progress()
    const now = Date.now()
    const at = stamp()
    const passed = score >= s.passScore
    let lessonUpdate = null
    if (q.lessonId) {
      const prev = p.items[q.lessonId] || {}
      const next = nextReview(prev, score, now, s.passScore)
      p.items[q.lessonId] = { ...prev, ...next, lessonId: q.lessonId, title: q.lessonTitle || q.title }
      lessonUpdate = {
        lessonId: q.lessonId,
        streak: next.streak,
        dueAt: next.dueAt,
        angle: next.angle,
        seen: next.seen,
      }
    }
    p.attempts.push({ qid: q.id, lessonId: q.lessonId || '', score, passed, note, at, angle: q.angle || '' })
    try { saveProgress(p) } catch (err) {
      return { ok: false, error: { code: 'write-failed', message: 'progress.json 写入失败：' + (err && err.message) } }
    }

    if (round !== null) {
      round.answered[q.id] = { score, note, at, passed }
      if (Object.keys(round.answered).length >= round.questions.length) armNext(Date.now())
    }
    return { ok: true, value: { id: q.id, score, passed, maxScore: s.maxScore, passScore: s.passScore, note, lesson: lessonUpdate } }
  }

  // ---------------------------------------------------------------- 题库维护
  function bankList() {
    const qs = questions()
    const ls = lessons()
    const p = progress()
    const now = Date.now()
    const lessonById = {}
    for (const l of ls) lessonById[l.id] = l
    return {
      ok: true,
      value: {
        questions: qs.map(q => ({
          ...q,
          review: p.items[q.lessonId] ? {
            seen: p.items[q.lessonId].seen || 0,
            streak: p.items[q.lessonId].streak || 0,
            dueAt: p.items[q.lessonId].dueAt || '',
            dueInMinutes: dueInMinutes(p.items[q.lessonId], now),
            angle: p.items[q.lessonId].angle || '',
          } : null,
          hasLesson: Boolean(lessonById[q.lessonId]),
        })),
        lessons: ls.map(l => ({
          ...l,
          review: p.items[l.id] ? {
            seen: p.items[l.id].seen || 0,
            streak: p.items[l.id].streak || 0,
            dueAt: p.items[l.id].dueAt || '',
            dueInMinutes: dueInMinutes(p.items[l.id], now),
            angle: p.items[l.id].angle || '',
          } : null,
          questionCount: qs.filter(q => q.lessonId === l.id).length,
        })),
        totals: {
          questions: qs.length,
          lessons: ls.length,
          dueNow: Object.keys(p.items).filter(id => isDue(p.items[id], now)).length,
          attempts: p.attempts.length,
        },
        warnings: qs.length === 0 ? ['题库为空：导入一批，或用模型生成'] : [],
      },
    }
  }

  /** 批量 upsert：同 id 覆盖，新 id 追加。 */
  function upsert(kind, records) {
    if (kind === 'lessons') {
      const list = lessons()
      const byId = {}
      list.forEach((l, i) => { byId[l.id] = i })
      let added = 0
      let updated = 0
      for (const rec of records) {
        if (!rec.id) rec.id = newId('L-')
        if (byId[rec.id] === undefined) { list.push(rec); byId[rec.id] = list.length - 1; added += 1 }
        else { list[byId[rec.id]] = { ...list[byId[rec.id]], ...rec }; updated += 1 }
      }
      saveLessons(list)
      return { added, updated, total: list.length }
    }
    const list = questions()
    const byId = {}
    list.forEach((q, i) => { byId[q.id] = i })
    let added = 0
    let updated = 0
    for (const rec of records) {
      if (!rec.id) rec.id = newId('Q-')
      if (!rec.lessonId) rec.lessonId = 'L-' + String(rec.title || '').toLowerCase().replace(/\s+/g, '-').slice(0, 40)
      if (byId[rec.id] === undefined) { list.push(rec); byId[rec.id] = list.length - 1; added += 1 }
      else { list[byId[rec.id]] = { ...list[byId[rec.id]], ...rec }; updated += 1 }
    }
    saveQuestions(list)
    return { added, updated, total: list.length }
  }

  function removeItem(kind, id) {
    if (kind === 'lessons') {
      const list = lessons()
      const next = list.filter(l => l.id !== id)
      if (next.length === list.length) return { ok: false, error: { code: 'not-found', message: '没有这个知识点' } }
      saveLessons(next)
      const p = progress()
      delete p.items[id]
      saveProgress(p)
      return { ok: true, value: { removed: 1, total: next.length } }
    }
    const list = questions()
    const next = list.filter(q => q.id !== id)
    if (next.length === list.length) return { ok: false, error: { code: 'not-found', message: '没有这道题' } }
    saveQuestions(next)
    return { ok: true, value: { removed: 1, total: next.length } }
  }

  /** 下次还能被问到（手动重置复习进度）。 */
  function resetLesson(id) {
    const p = progress()
    if (!p.items[id]) return { ok: false, error: { code: 'not-found', message: '这个知识点还没学过' } }
    delete p.items[id]
    saveProgress(p)
    return { ok: true, value: { reset: id } }
  }

  // ---------------------------------------------------------------- API
  function respond(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  function respondText(res, status, text, filename, contentType) {
    res.writeHead(status, {
      'content-type': contentType || 'text/csv; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': 'attachment; filename="' + filename + '"',
    })
    res.end(text)
  }
  function isLoopback(req) {
    const host = String((req && req.headers && req.headers.host) || '')
    return /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(host)
  }
  async function readBody(req) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      // chunk 可能是 Buffer 也可能是 string（上游设过 encoding），统一成 Buffer
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > MAX_BODY) throw new Error('body too large（上限 ' + Math.round(MAX_BODY / 1024 / 1024) + 'MB）')
      chunks.push(buf)
    }
    return Buffer.concat(chunks)
  }
  // 注意：这里不能叫 readJson —— 会遮蔽从 store.js import 的 readJson，导致读设置时把路径当 JSON 解析
  async function readJsonBody(req) {
    const buf = await readBody(req)
    if (buf.length === 0) return {}
    return JSON.parse(buf.toString('utf8'))
  }

  async function handle(req, res) {
    if (!isLoopback(req)) return respond(res, 403, { ok: false, error: { code: 'forbidden', message: 'loopback only' } })
    const url = new URL(req.url || '/', 'http://' + String(req.headers.host || '127.0.0.1'))
    let p = url.pathname.replace(/\/+$/, '')
    if (p.startsWith(API_PREFIX)) p = p.slice(API_PREFIX.length) || '/'
    const m = req.method
    const qp = url.searchParams

    try {
      // ---- 轮次
      if (m === 'GET' && (p === '/state' || p === '/')) { tick(Date.now()); return respond(res, 200, state()) }
      if (m === 'GET' && p === '/key') return respond(res, 200, keyOf(qp.get('id') || ''))
      if (m === 'POST' && p === '/submit') {
        const b = await readJsonBody(req)
        const r = submit(b.qid, b.score, b.note)
        return respond(res, r.ok ? 200 : 400, r)
      }
      if (m === 'POST' && p === '/tab') {
        const b = await readJsonBody(req)
        if (round !== null) round.tab = b.tab === 'quiz' ? 'quiz' : 'study'
        return respond(res, 200, state())
      }
      if (m === 'POST' && p === '/regenerate') {
        round = composeOnce().round
        armNext(Date.now())
        return respond(res, 200, state())
      }
      if (m === 'POST' && p === '/snooze') {
        if (round !== null) round.snoozeUntil = Date.now() + settings().intervalMinutes * 60 * 1000
        armNext(Date.now())
        return respond(res, 200, state())
      }
      if (m === 'POST' && p === '/dismiss') {
        if (round !== null) { round.skipped = true; round.snoozeUntil = 0 }
        armNext(Date.now())
        return respond(res, 200, { ok: true })
      }
      // 主动打开：不等 10 分钟，立刻把当前轮（没有就现攒一轮）弹出来。
      // 客户端靠 showSeq 变化判断「该重新弹了」，所以这里必须 +1；同时清掉 skipped/snooze。
      if (m === 'POST' && p === '/open') {
        const now = Date.now()
        if (round === null) {
          round = composeOnce().round
          if (nextRoundAt === 0) armNext(now)
        } else {
          round.skipped = false
          round.snoozeUntil = 0
          round.showSeq += 1
        }
        return respond(res, 200, state())
      }

      // ---- 学习卡
      if (m === 'GET' && p === '/lesson') {
        const d = lessonDetail(qp.get('id') || '')
        return respond(res, d.ok ? 200 : 404, d)
      }
      if (m === 'GET' && p === '/bank') return respond(res, 200, bankList())
      if (m === 'POST' && p === '/bank/upsert') {
        const b = await readJsonBody(req)
        const kind = b.kind === 'lessons' ? 'lessons' : 'questions'
        const records = []
        for (const raw of (Array.isArray(b.records) ? b.records : [b.record])) {
          const rec = kind === 'lessons' ? normalizeLesson(raw, idCtx) : normalizeQuestion(raw, idCtx)
          if (rec) records.push(rec)
        }
        if (records.length === 0) return respond(res, 400, { ok: false, error: { code: 'bad-request', message: '没有有效记录（标题必填）' } })
        return respond(res, 200, { ok: true, value: upsert(kind, records) })
      }
      if (m === 'POST' && p === '/bank/delete') {
        const b = await readJsonBody(req)
        const r = removeItem(b.kind === 'lessons' ? 'lessons' : 'questions', String(b.id || ''))
        return respond(res, r.ok ? 200 : 404, r)
      }
      if (m === 'POST' && p === '/bank/reset-review') {
        const b = await readJsonBody(req)
        const r = resetLesson(String(b.id || ''))
        return respond(res, r.ok ? 200 : 404, r)
      }
      // 导入：text（JSON/CSV 粘贴）或 base64（xlsx 上传）
      if (m === 'POST' && p === '/bank/import') {
        const b = await readJsonBody(req)
        const kind = b.kind === 'lessons' ? 'lessons' : 'questions'
        let result
        if (b.base64) {
          const buf = Buffer.from(String(b.base64), 'base64')
          if (buf.length === 0) return respond(res, 400, { ok: false, error: { code: 'bad-request', message: '文件是空的' } })
          if (buf.length > MAX_BODY) return respond(res, 400, { ok: false, error: { code: 'bad-request', message: '文件太大' } })
          result = recordsFromFile(buf, String(b.filename || ''), kind, idCtx)
        } else if (String(b.text || '').trim()) {
          const text = String(b.text)
          if (/^[[{]/.test(text.trim())) result = recordsFromJsonText(text, kind, idCtx)
          else result = rowsToRecords(parseDelimited(text), kind, idCtx)
        } else {
          return respond(res, 400, { ok: false, error: { code: 'bad-request', message: '要么给 text（JSON/CSV），要么给 base64（文件）' } })
        }
        if (result.records.length === 0) {
          return respond(res, 400, {
            ok: false,
            error: { code: 'bad-request', message: '没解析出有效记录：' + (result.warnings.join('；') || '格式不对') },
            value: { warnings: result.warnings },
          })
        }
        const summary = upsert(kind, result.records)
        return respond(res, 200, { ok: true, value: { ...summary, warnings: result.warnings, imported: result.records.length } })
      }
      if (m === 'GET' && p === '/bank/export') {
        const kind = String(qp.get('kind') || 'questions')
        if (kind === 'lessons') return respondText(res, 200, lessonsToCsv(lessons()), 'study-loop-lessons.csv')
        if (kind === 'progress') return respondText(res, 200, progressToCsv(progress(), questions()), 'study-loop-progress.csv')
        return respondText(res, 200, questionsToCsv(questions()), 'study-loop-questions.csv')
      }
      if (m === 'GET' && p === '/bank/template') {
        const kind = String(qp.get('kind') || 'questions')
        if (kind === 'lessons') {
          const csv = '\uFEFF标题,摘要,内容,要点,标签\r\n"示例：SSE 是什么","服务端按行推送的纯文本协议","SSE 是 text/event-stream ...","按行分帧 | 空行是事件边界 | data: 前缀要剥","流式/网络"\r\n'
          return respondText(res, 200, csv, 'study-loop-lessons-template.csv')
        }
        const csv = '\uFEFF标题,知识点,题干,判分要点,提示,参考答案,常见错法,类型,角度\r\n"为什么要自己解析 SSE","为什么要自己解析 SSE","说一下 data: {...} 是谁生成的？","SSE 是按行推送 | 空行是事件边界 | [DONE] 才是结束 | 半包要按行切","想想字节流和消息流的区别","服务端把每个 chunk 写成 data: {json}\\n\\n ...","直接 response.json() 解析","概念","原理"\r\n'
        return respondText(res, 200, csv, 'study-loop-questions-template.csv')
      }

      // ---- 设置
      if (m === 'GET' && p === '/settings') return respond(res, 200, { ok: true, value: publicSettings() })
      if (m === 'POST' && p === '/settings') {
        const b = await readJsonBody(req)
        const cur = settings()
        const next = { ...cur }
        for (const key of ['intervalMinutes', 'questionsPerRound', 'reviewSlots', 'passScore', 'prompt']) {
          if (b[key] !== undefined) next[key] = b[key]
        }
        if (b.model && typeof b.model === 'object') {
          next.model = { ...cur.model, ...b.model }
          // 掩码值原样回去 = 用户没改 key
          if (typeof next.model.apiKey === 'string' && next.model.apiKey.indexOf('••••') === 0) next.model.apiKey = cur.model.apiKey
        }
        saveSettings(next)
        const s = settings()
        armNext(Date.now())
        return respond(res, 200, { ok: true, value: publicSettings() })
      }
      if (m === 'GET' && p === '/settings/default-prompt') {
        return respond(res, 200, { ok: true, value: { prompt: defaultSettings().prompt } })
      }

      // ---- 模型生成
      if (m === 'POST' && p === '/generate/preview-prompt') {
        const b = await readJsonBody(req)
        const s = settings()
        const text = fillPrompt(s.prompt, {
          count: Number(b.count) || s.questionsPerRound,
          topic: String(b.topic || ''),
          lessons: lessonsBrief(lessons()),
          angles: ANGLES.join(' / '),
        })
        return respond(res, 200, { ok: true, value: { prompt: text } })
      }
      if (m === 'POST' && p === '/generate/questions') {
        const b = await readJsonBody(req)
        const s = settings()
        const result = await generateQuestions({
          model: s.model,
          prompt: s.prompt,
          lessons: lessons(),
          count: Number(b.count) || s.questionsPerRound,
          topic: b.topic ? String(b.topic) : '',
          ctx: idCtx,
          env: process.env,
        })
        const summary = upsert('questions', result.questions)
        return respond(res, 200, { ok: true, value: { ...summary, warnings: result.warnings, usage: result.usage || null, generated: result.questions.length } })
      }
      if (m === 'POST' && p === '/generate/lesson') {
        const b = await readJsonBody(req)
        const s = settings()
        const made = await generateLesson({ model: s.model, topic: String(b.topic || ''), env: process.env })
        const rec = normalizeLesson({ ...made, tags: b.tags }, idCtx)
        if (!rec) return respond(res, 400, { ok: false, error: { code: 'bad-request', message: '生成的卡片没有标题' } })
        const summary = upsert('lessons', [rec])
        return respond(res, 200, { ok: true, value: { ...summary, lesson: rec, warnings: [] } })
      }

      return respond(res, 404, { ok: false, error: { code: 'not-found', message: 'no route: ' + p } })
    } catch (err) {
      const msg = String((err && err.message) || err)
      const isClientError = /^(缺 |给要|模型|JSON|没解析|body too large)/.test(msg) || /必填/.test(msg)
      return respond(res, isClientError ? 400 : 500, { ok: false, error: { code: isClientError ? 'bad-request' : 'internal', message: msg } })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: (req, res) => { void handle(req, res) },
  }), 'study-loop: http api')

  // 首次启动：建目录、播种、算第一轮
  try {
    fs.mkdirSync(dataDir, { recursive: true })
    if (!fs.existsSync(fileOf('settings'))) saveSettings(defaultSettings())
    seedFromLegacy()
    if (!fs.existsSync(fileOf('questions'))) saveQuestions(emptyQuestions().questions)
    if (!fs.existsSync(fileOf('lessons'))) saveLessons(emptyLessons().lessons)
    if (!fs.existsSync(fileOf('progress'))) saveProgress(emptyProgress())
    tick(Date.now())
  } catch (err) {
    log('初始化失败：' + ((err && err.message) || err))
  }

  return Object.assign(() => { round = null; nextRoundAt = 0 }, {
    getState: () => { tick(Date.now()); return state() },
    submit,
    keyOf,
    bankList,
    dataDir,
  })
}

export { defaultSettings, mergeSettings, parseTime, isoLocal }
