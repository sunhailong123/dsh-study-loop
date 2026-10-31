// 间隔重复调度：算下次复习时间、换角度、以及每轮「新题 + 旧知识」的配比。
// 设计取舍：
// - 不用完整 SM-2：这里问的是理解题（0-5 自评），间隔按档位阶梯走就够，可解释、能调参。
// - 角度（angle）必须轮换：同一知识点第二次被问时换一个角度，避免「记住题目」而不是「记住知识」。
import { ANGLES, parseTime, isoLocal, toStringList } from './store.js'

// 转发出去：别的模块（generate.js / index.js）要从这里拿角度池，避免到处 import store
export { ANGLES }

/** 间隔阶梯（分钟）：分数越高，隔得越久。索引 = 第几次「过关」。 */
export const LADDER = [30, 180, 720, 2880, 10080, 43200]

/**
 * 由一次作答算出下次复习时间与角度。
 * @param {object} item  progress.items[lessonId] 现有记录
 * @param {number} score 0-5
 * @param {number} now   毫秒时间戳
 * @param {number} passScore
 */
export function nextReview(item, score, now, passScore) {
  const prev = item && typeof item === 'object' ? item : {}
  const streak = Math.max(0, Number(prev.streak) || 0)
  const passed = score >= passScore
  // 过关：档次 +1（上限封顶）；没过关：直接回到第一档，让他尽快再见到这个知识点
  const level = passed ? Math.min(streak + 1, LADDER.length) : 1
  const minutes = LADDER[level - 1]
  const due = now + minutes * 60 * 1000
  const angleIdx = (Number(prev.angleIdx) || 0) + 1
  return {
    streak: level,
    dueAt: isoLocal(new Date(due)),
    angleIdx,
    angle: ANGLES[angleIdx % ANGLES.length],
    lastScore: score,
    lastAt: isoLocal(new Date(now)),
    seen: (Number(prev.seen) || 0) + 1,
  }
}

/** 某条学习记录是否到期该复习了。 */
export function isDue(item, now) {
  if (!item) return false
  const due = parseTime(item.dueAt)
  if (!due) return true // 学过但从没排过期 → 立刻可复习
  return due <= now
}

export function dueInMinutes(item, now) {
  const due = parseTime(item && item.dueAt)
  if (!due) return 0
  return Math.max(0, Math.round((due - now) / 60000))
}

/** 一次性新知识点（从没学过）→ 立刻可学。 */
export function isNew(item) {
  return !item || !Number(item.seen)
}

/**
 * 选出一轮要问的题：
 * - 先按「已到期的旧知识」填 reviewSlots 个位置（最久没见到的优先，换角度重问）；
 * - 剩下的位置给「没做过的题」（新题按计划顺序）；
 * - 都不够就用「未到期但最久没碰」的补满，保证一轮永远有 5 道。
 * @returns {{questions: object[], reviewIds: string[], warnings: string[]}}
 */
export function composeRound({ questions, progress, perRound, reviewSlots, now, offset = 0, warnings = [] }) {
  const items = (progress && progress.items) || {}
  const reviewable = []
  const fresh = []
  const rest = []
  for (const q of questions) {
    const item = q.lessonId ? items[q.lessonId] : null
    if (item && Number(item.seen) > 0) {
      if (isDue(item, now)) reviewable.push({ q, item })
      else rest.push({ q, item })
    } else {
      fresh.push(q)
    }
  }
  // 到期的旧知识：最久没见的先上
  reviewable.sort((a, b) => parseTime(a.item.dueAt) - parseTime(b.item.dueAt))
  // 新题：按班内顺序，但用 offset 轮换起点，避免每次都是同样几道
  const freshStart = fresh.length ? (((offset % fresh.length) + fresh.length) % fresh.length) : 0
  const freshRotated = fresh.slice(freshStart).concat(fresh.slice(0, freshStart))

  const picked = []
  const reviewIds = []
  const slots = Math.max(0, Math.min(reviewSlots, perRound))
  for (const entry of reviewable.slice(0, slots)) {
    picked.push(withAngle(entry.q, entry.item, warnings))
    if (entry.q.lessonId) reviewIds.push(entry.q.lessonId)
  }
  for (const q of freshRotated) {
    if (picked.length >= perRound) break
    picked.push(withAngle(q, null, warnings))
  }
  if (picked.length < perRound) {
    rest.sort((a, b) => parseTime(a.item.dueAt) - parseTime(b.item.dueAt))
    for (const entry of rest) {
      if (picked.length >= perRound) break
      if (reviewIds.includes(entry.q.lessonId)) continue
      picked.push(withAngle(entry.q, entry.item, warnings))
      if (entry.q.lessonId) reviewIds.push(entry.q.lessonId)
    }
  }
  if (picked.length < perRound && questions.length > 0) {
    // 题库比每轮题数少：绝不拿同一道题重复填坑（重复 id 会让"已答"记错、一轮里出现两道一模一样的题），
    // 就少问几道，并在浮层上直说缺多少题。
    warnings.push('题库只有 ' + questions.length + ' 道题，本轮凑不满 ' + perRound + ' 道：去「题库」页加题或用模型生成。')
  }
  if (questions.length === 0) warnings.push('题库是空的：去「题库」页加题，或用模型生成一批。')
  return { questions: picked, reviewIds, warnings }
}

/** 给题面注入本轮角度：复习题用轮换角度，新题用题目自带角度或默认「原理」。 */
function withAngle(q, item, warnings) {
  const angle = item && item.seen ? (item.angle || ANGLES[(Number(item.angleIdx) || 1) % ANGLES.length]) : (q.angle || ANGLES[0])
  const out = { ...q, angle }
  // 复习轮：题面提示「换个角度」，但题仍是原题——由前端提示用户这是旧知识
  out.isReview = !!(item && Number(item.seen) > 0)
  out.dueLabel = item && item.dueAt ? String(item.dueAt) : ''
  if (out.isReview && !String(out.reviewPrompt || '').trim()) {
    // 有 reviewPrompt 就用它（同一个知识点换角度问的专用问法）
    out.reviewPrompt = ''
  }
  return out
}

/** 学生视角的题面：绝不带 rubric / answer / trap。 */
export function studentView(q) {
  return {
    id: q.id,
    lessonId: q.lessonId || '',
    lessonTitle: q.lessonTitle || '',
    type: q.type || '',
    angle: q.angle || '',
    title: q.title || '',
    prompt: q.reviewPrompt && q.isReview ? q.reviewPrompt : (q.prompt || ''),
    hint: q.hint || '',
    isReview: !!q.isReview,
    dueLabel: q.dueLabel || '',
  }
}

/** 规范化一道题（导入 / 生成 / 手填都要过这一层）。 */
export function normalizeQuestion(raw, ctx) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const title = String(src.title || src.标题 || '').trim()
  if (!title) return null
  const lessonTitle = String(src.lessonTitle || src.lesson || src.知识点 || src.knowledge || '').trim()
  const lessonId = String(src.lessonId || '').trim() || (lessonTitle ? 'L-' + slug(lessonTitle) : '')
  return {
    id: String(src.id || '').trim() || (ctx && ctx.newId ? ctx.newId('Q-') : ''),
    lessonId,
    lessonTitle,
    type: String(src.type || src.类型 || '理解').trim() || '理解',
    angle: String(src.angle || src.角度 || '').trim() || ANGLES[0],
    title,
    prompt: String(src.prompt || src.题干 || src.question || '').trim() || title,
    reviewPrompt: String(src.reviewPrompt || src.复习问法 || '').trim(),
    rubric: toStringList(src.rubric || src.判分要点 || src.keyPoints),
    hint: String(src.hint || src.提示 || '').trim(),
    answer: String(src.answer || src.参考答案 || '').trim(),
    trap: String(src.trap || src.常见错法 || '').trim(),
    source: String(src.source || 'manual').trim() || 'manual',
    createdAt: String(src.createdAt || (ctx && ctx.stamp ? ctx.stamp() : '')).trim(),
  }
}

/** 规范化一条学习卡（知识点）。 */
export function normalizeLesson(raw, ctx) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const title = String(src.title || src.标题 || '').trim()
  if (!title) return null
  return {
    // id 必须由标题派生，才能和题目的 lessonId（同样由 lessonTitle 派生）对上，
    // 否则导入的题目永远挂不到学习卡上，学习 tab 就是空的。
    id: String(src.id || '').trim() || 'L-' + slug(title),
    title,
    summary: String(src.summary || src.摘要 || '').trim(),
    body: String(src.body || src.内容 || src.points || '').trim(),
    keyPoints: toStringList(src.keyPoints || src.要点),
    tags: toStringList(src.tags || src.标签),
    createdAt: String(src.createdAt || (ctx && ctx.stamp ? ctx.stamp() : '')).trim(),
  }
}

/** 标题 → 稳定 slug（当 lessonId 用；中文原样保留，去掉空白与标点）。 */
export function slug(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[\\/:*?"<>|,，。；;：！!？?（）()【】\[\]{}'"`~@#$%^&+=]+/g, '')
    .slice(0, 48)
}
