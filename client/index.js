// dsh-study-loop — 浏览器端。
// 一个自绘浮层，四个 tab：
//   学习（默认）→ 先看清这一轮要考的知识点，看完再切「答题」
//   答题       → 5 道题 + 自评 + 对照判分要点
//   题库       → 粘贴 JSON/CSV、上传 Excel、用模型生成题目/学习卡、删题、导出
//   设置       → 节奏、模型端点、出题提示词
// 不占任何注入槽位：浮层直接挂 document.body（没选会话/在设置页时也照弹）。
// 降级原则：任何接口失败都只让浮层显示一句错误，绝不影响主界面。
window.__ModuleLoader__.load({
  id: 'dsh-study-loop',
  factory: function (require) {
    var API = '/study-loop/api'
    var POLL_MS = 5000
    var DRAFT_PREFIX = 'study-loop:draft:'
    var TAB_KEY = 'study-loop:tab'

    var CSS = [
      '.sl-dim{position:fixed;inset:0;z-index:2147482900;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}',
      '.sl-card{width:min(980px,96vw);max-height:92vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#1b1f24);color:var(--dsw-alias-label-primary,#e6edf3);border:1px solid var(--dsw-alias-border-l2,#30363d);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.55);font:13px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden}',
      '.sl-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l2,#30363d);flex:0 0 auto}',
      '.sl-title{font-weight:600;font-size:14px}',
      '.sl-sub{opacity:.65;font-size:12px}',
      '.sl-spacer{flex:1}',
      '.sl-tabs{display:flex;gap:4px;padding:8px 14px 0;flex:0 0 auto}',
      '.sl-tab{font:inherit;font-size:12.5px;padding:5px 12px;border-radius:8px 8px 0 0;border:1px solid transparent;border-bottom:none;background:transparent;color:var(--dsw-alias-label-secondary,#c9d1d9);cursor:pointer}',
      '.sl-tab.on{background:var(--dsw-alias-bg-layer-2,#11151a);border-color:var(--dsw-alias-border-l2,#30363d);color:var(--dsw-alias-label-primary,#e6edf3);font-weight:600}',
      '.sl-body{overflow:auto;padding:12px 14px;display:flex;flex-direction:column;gap:10px;flex:1 1 auto;border-top:1px solid var(--dsw-alias-border-l2,#30363d)}',
      '.sl-sec{border:1px solid var(--dsw-alias-border-l2,#30363d);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.sl-sec>h4{margin:0;font-size:12.5px;font-weight:600;opacity:.9}',
      '.sl-carditem{border:1px solid var(--dsw-alias-border-l2,#30363d);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:6px}',
      '.sl-carditem.review{border-color:#d2992255;background:#d2992210}',
      '.sl-q{border:1px solid var(--dsw-alias-border-l2,#30363d);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.sl-q.done-ok{border-color:#2ea04366;background:#2ea04312}',
      '.sl-q.done-bad{border-color:#e5484d66;background:#e5484d12}',
      '.sl-id{font-size:11px;opacity:.6;letter-spacing:.04em}',
      '.sl-t{font-weight:600;font-size:13px}',
      '.sl-prompt{white-space:pre-wrap;opacity:.92;font-size:12.5px}',
      '.sl-bodytext{white-space:pre-wrap;font-size:12.5px;opacity:.9}',
      '.sl-code{white-space:pre-wrap;font:12px/1.5 ui-monospace,Consolas,monospace;background:var(--dsw-alias-bg-layer-2,#11151a);border:1px solid var(--dsw-alias-border-l2,#30363d);border-radius:8px;padding:8px 10px;overflow:auto;max-height:240px}',
      '.sl-ta{width:100%;box-sizing:border-box;min-height:80px;resize:vertical;background:var(--dsw-alias-bg-layer-2,#11151a);color:inherit;border:1px solid var(--dsw-alias-border-l2,#30363d);border-radius:8px;padding:8px 10px;font:12.5px/1.55 inherit;font-family:inherit}',
      '.sl-in{background:var(--dsw-alias-bg-layer-2,#11151a);color:inherit;border:1px solid var(--dsw-alias-border-l2,#30363d);border-radius:7px;padding:5px 8px;font:12.5px/1.5 inherit;font-family:inherit;min-width:0}',
      '.sl-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.sl-btn{font:inherit;font-size:12px;padding:4px 10px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#30363d);background:transparent;color:var(--dsw-alias-label-secondary,#c9d1d9);cursor:pointer;white-space:nowrap}',
      '.sl-btn:hover{background:var(--dsw-alias-bg-layer-2,#11151a)}',
      '.sl-btn.primary{border-color:#2f81f7;color:#79b8ff}',
      '.sl-btn.danger{border-color:#e5484d77;color:#f85149}',
      '.sl-btn.on{background:#1f6feb;border-color:#1f6feb;color:#fff}',
      '.sl-btn:disabled{opacity:.45;cursor:default}',
      '.sl-rubric{margin:0;padding-left:18px;font-size:12px;opacity:.9}',
      '.sl-rubric li{margin:2px 0}',
      '.sl-note{font-size:12px;padding:6px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#30363d);background:var(--dsw-alias-bg-layer-2,#11151a)}',
      '.sl-warn{color:#e3b341;font-size:12px;white-space:pre-wrap}',
      '.sl-err{color:#f85149;font-size:12px;white-space:pre-wrap}',
      '.sl-ok{color:#3fb950;font-size:12px;white-space:pre-wrap}',
      '.sl-foot{display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l2,#30363d);flex:0 0 auto}',
      '.sl-chip{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#30363d);font-size:11px;background:transparent;color:inherit}',
      '.sl-chip.rv{border-color:#d29922;color:#e3b341}',
      '.sl-x{font:inherit;font-size:16px;line-height:1;padding:2px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2,#30363d);background:transparent;color:inherit;cursor:pointer}',
      '.sl-list{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}',
      '.sl-item{display:flex;align-items:center;gap:8px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2,#30363d);border-radius:8px;font-size:12px}',
      '.sl-item .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sl-fab{position:fixed;right:18px;bottom:18px;z-index:2147482899;display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#30363d);background:var(--dsw-alias-bg-layer-1,#1b1f24);color:var(--dsw-alias-label-primary,#e6edf3);font:12px/1 inherit;font-family:inherit;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.38);opacity:.85}',
      '.sl-fab:hover{opacity:1}',
      '.sl-fab .sl-dot{min-width:16px;height:16px;padding:0 4px;border-radius:999px;background:#1f6feb;color:#fff;font-size:11px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box}',
    ].join('\n')

    var TABS = [
      { id: 'study', label: '学习' },
      { id: 'quiz', label: '答题' },
      { id: 'bank', label: '题库' },
      { id: 'settings', label: '设置' },
    ]

    var state = {
      styleInjected: false,
      dim: null,
      card: null,
      body: null,
      sig: '',
      visible: false,
      fab: null,
      fabLabel: null,
      tab: 'study',
      roundId: null,
      showSeq: 0,
      round: null,
      meta: null,
      error: null,
      notice: null,
      keys: {},
      scores: {},
      notes: {},
      showAnswer: {},
      busy: {},
      nextInMs: 0,
      nextAt: 0,
      timer: null,
      poll: null,
      // 题库页
      bank: null,
      bankError: null,
      bankBusy: false,
      importText: '',
      importKind: 'questions',
      importInfo: null,
      genCount: 5,
      genTopic: '',
      lessonTopic: '',
      showQList: false,
      showLList: false,
      lessonView: null,
      promptPreview: null,
      // 设置页
      settings: null,
      settingsBusy: false,
      promptDraft: null,
      modelDraft: null,
      intervalDraft: null,
      perRoundDraft: null,
      reviewSlotsDraft: null,
    }

    function injectStyle() {
      if (state.styleInjected) return
      var el = document.createElement('style')
      el.setAttribute('data-study-loop', '')
      el.textContent = CSS
      document.head.appendChild(el)
      state.styleInjected = true
    }

    function h(tag, props, children) {
      var el = document.createElement(tag)
      if (props) {
        for (var k in props) {
          if (k === 'style') el.style.cssText = props[k]
          else if (k === 'text') el.textContent = props[k]
          else if (k.indexOf('on') === 0 && typeof props[k] === 'function') el.addEventListener(k.slice(2).toLowerCase(), props[k])
          else if (props[k] !== undefined && props[k] !== null && props[k] !== false) el.setAttribute(k, props[k] === true ? '' : props[k])
        }
      }
      var kids = children || []
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i]
        if (c === null || c === undefined || c === false) continue
        el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
      }
      return el
    }

    function api(path, opts) {
      var conf = Object.assign({ headers: { 'content-type': 'application/json' } }, opts || {})
      return fetch(API + path, conf)
        .then(function (r) { return r.json() })
        .catch(function (err) { return { ok: false, error: { message: String((err && err.message) || err) } } })
    }

    function mmss(ms) {
      if (ms <= 0) return '00:00'
      var s = Math.floor(ms / 1000)
      var m = Math.floor(s / 60)
      var r = s % 60
      return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r
    }

    function draftKey(qid) { return DRAFT_PREFIX + (state.roundId || '') + ':' + qid }
    function loadDraft(qid) { try { return localStorage.getItem(draftKey(qid)) || '' } catch (e) { return '' } }
    function saveDraft(qid, val) { try { localStorage.setItem(draftKey(qid), val) } catch (e) { /* 存不了就算了 */ } }
    function clearDraft(qid) { try { localStorage.removeItem(draftKey(qid)) } catch (e) { /* ignore */ } }

    // ---------------------------------------------------------------- 渲染入口
    function render() {
      if (!state.visible) {
        if (state.dim && state.dim.parentNode) state.dim.parentNode.removeChild(state.dim)
        state.dim = null
        state.card = null
        state.body = null
        state.sig = stateSignature()
        renderFab()
        return
      }
      injectStyle()
      // 浮层开着时先收掉右下角小按钮，避免叠在卡片上
      if (state.fab && state.fab.parentNode) state.fab.parentNode.removeChild(state.fab)
      state.fab = null
      // 重画会把 .sl-body 换成一个新元素，滚动位置会归零 —— 先记住再还原。
      var keepScroll = state.body ? (Number(state.body.scrollTop) || 0) : 0
      if (!state.dim) {
        state.dim = h('div', { class: 'sl-dim' }, [])
        document.body.appendChild(state.dim)
      }
      var round = state.round
      var qs = round ? round.questions || [] : []
      var answered = round ? round.answered || {} : {}
      var doneCount = Object.keys(answered).length

      var head = h('div', { class: 'sl-head' }, [
        h('div', {}, [
          h('div', { class: 'sl-title', text: '学习循环 · 先学后答' }),
          h('div', {
            class: 'sl-sub',
            text: round
              ? ('开始于 ' + round.askedAt + ' · ' + qs.length + ' 题 · 已答 ' + doneCount + '/' + qs.length)
              : '正在取题…',
          }),
        ]),
        h('div', { class: 'sl-spacer' }),
        h('button', { class: 'sl-x', title: '收起（下一轮照常到点）', onclick: function () { void dismiss() } }, ['×']),
      ])

      var tabBar = h('div', { class: 'sl-tabs' }, TABS.map(function (t) {
        return h('button', {
          class: 'sl-tab' + (state.tab === t.id ? ' on' : ''),
          onclick: function () { switchTab(t.id) },
        }, [t.label])
      }))

      var body = h('div', { class: 'sl-body' }, [])
      var warns = ((round && round.warnings) || []).slice()
      if (state.error) warns.push(state.error)
      if (warns.length) body.appendChild(h('div', { class: 'sl-warn', text: '⚠ ' + warns.join('；') }))
      if (state.notice) body.appendChild(h('div', { class: 'sl-ok', text: '✓ ' + state.notice }))

      if (state.tab === 'study') renderStudy(body, round)
      else if (state.tab === 'quiz') renderQuiz(body, round)
      else if (state.tab === 'bank') renderBank(body)
      else renderSettings(body)

      var foot = h('div', { class: 'sl-foot' }, [
        h('div', { class: 'sl-sub', text: '下一轮 ' + mmss(state.nextInMs) }),
        h('div', { class: 'sl-spacer' }),
        h('button', { class: 'sl-btn', title: '重新抽题（当前轮作废）', onclick: function () { void regenerate() } }, ['换一批']),
        h('button', { class: 'sl-btn', onclick: function () { void snooze() } }, ['+10 分钟后']),
        h('button', { class: 'sl-btn primary', onclick: function () { void dismiss() } }, ['收起']),
      ])

      var card = h('div', { class: 'sl-card' }, [head, tabBar, body, foot])
      state.card = card
      state.body = body
      state.dim.textContent = ''
      state.dim.appendChild(card)
      // 还原滚动位置：轮询每 5 秒重画一次，不还原的话正在看的题会被弹回顶部。
      if (keepScroll > 0) body.scrollTop = keepScroll
      state.sig = stateSignature()
    }

    // 右下角的常驻小按钮：浮层收起后仍然留着，点一下就重新打开（不用等 10 分钟）。
    function renderFab() {
      injectStyle()
      var pending = state.round ? (Number(state.round.pendingCount) || 0) : 0
      var label = pending > 0 ? '学习循环 · 还有 ' + pending + ' 题' : '学习循环'
      if (state.fab && state.fab.parentNode) {
        if (state.fabLabel) state.fabLabel.textContent = label
        return
      }
      state.fabLabel = h('span', { text: label })
      state.fab = h('button', {
        class: 'sl-fab',
        title: '打开学习循环（和每 10 分钟自动弹的是同一个浮层）',
        onclick: function () { void openPanel() },
      }, [
        h('span', { text: '📚' }),
        state.fabLabel,
      ])
      document.body.appendChild(state.fab)
    }

    // 主动打开：问后端要一轮（后端会把 showSeq +1），然后强制显示。
    function openPanel() {
      state.visible = true
      state.error = null
      render()
      return api('/open', { method: 'POST', body: '{}' }).then(function (res) {
        if (!res || !res.ok) {
          state.error = '打开失败：' + ((res && res.error && res.error.message) || '接口不可用')
          render()
          return
        }
        applyState(res.value, true)
        state.visible = true
        render()
      })
    }

    function switchTab(id) {
      state.tab = id
      try { localStorage.setItem(TAB_KEY, id) } catch (e) { /* ignore */ }
      state.notice = null
      state.error = null
      if (id === 'bank' && !state.bank) void loadBank()
      if (id === 'settings' && !state.settings) void loadSettings()
      render()
    }

    // ---------------------------------------------------------------- 学习 tab
    function renderStudy(body, round) {
      var items = round ? round.study || [] : []
      body.appendChild(h('div', { class: 'sl-sub', text: '先把这一轮要考的知识点看一遍，看完切到「答题」。' }))
      if (items.length === 0) {
        body.appendChild(h('div', { class: 'sl-sub', text: '这一轮没有学习卡。去「题库」加知识点，或用模型生成。' }))
        return
      }
      var freshCount = 0
      for (var i = 0; i < items.length; i++) {
        var it = items[i]
        if (!it.isReview) freshCount += 1
        if (it.isReview) {
          body.appendChild(h('div', { class: 'sl-carditem review' }, [
            h('div', { class: 'sl-row' }, [
              h('span', { class: 'sl-chip rv', text: '复习 · 换个角度' }),
              h('span', { class: 'sl-t', text: it.title }),
            ]),
            h('div', { class: 'sl-sub', text: '这个知识点你学过（最近 ' + (it.dueLabel || '—') + '），这次换个角度问' + (it.angle ? '：' + it.angle : '') + '。所以这里只给标题——先自己回想，想不起来就去题库翻原卡。' }),
            h('div', { class: 'sl-row' }, [
              h('button', { class: 'sl-btn', onclick: function (id) { return function () { void viewLesson(id) } }(it.id) }, ['翻原卡']),
              h('button', { class: 'sl-btn', onclick: function () { switchTab('quiz') } }, ['直接去答题']),
            ]),
          ]))
          continue
        }
        var keyList = h('ul', { class: 'sl-rubric' }, [])
        var kp = it.keyPoints || []
        for (var j = 0; j < kp.length; j++) keyList.appendChild(h('li', { text: kp[j] }))
        var box = h('div', { class: 'sl-carditem' }, [
          h('div', { class: 'sl-row' }, [
            h('span', { class: 'sl-chip', text: '新知识' }),
            h('span', { class: 'sl-t', text: it.title }),
            it.angle ? h('span', { class: 'sl-chip', text: '角度 ' + it.angle }) : null,
          ]),
        ])
        if (it.summary) box.appendChild(h('div', { class: 'sl-prompt', text: it.summary }))
        if (it.body) box.appendChild(h('div', { class: 'sl-bodytext', text: it.body }))
        if (kp.length) {
          box.appendChild(h('div', { class: 'sl-sub', text: '要点：' }))
          box.appendChild(keyList)
        }
        if (!it.body && !it.summary && !kp.length) {
          box.appendChild(h('div', { class: 'sl-warn', text: '这张卡只有标题，没有讲解内容。去「题库」补内容，或让模型生成一张。' }))
        }
        body.appendChild(box)
      }
      if (freshCount > 0) {
        body.appendChild(h('div', { class: 'sl-row' }, [
          h('button', { class: 'sl-btn primary', onclick: function () { switchTab('quiz') } }, ['看完了，去答题 →']),
        ]))
      }
    }

    function viewLesson(id) {
      if (!id) { state.error = '这道复习题没有关联知识点 id'; render(); return }
      api('/lesson?id=' + encodeURIComponent(id)).then(function (res) {
        if (!res || !res.ok) { state.error = '取不到学习卡：' + ((res && res.error && res.error.message) || '未知错误'); render(); return }
        state.lessonView = res.value
        render()
      })
    }

    // ---------------------------------------------------------------- 答题 tab
    function renderQuiz(body, round) {
      var qs = round ? round.questions || [] : []
      var answered = round ? round.answered || {} : {}
      if (qs.length === 0) {
        body.appendChild(h('div', { class: 'sl-sub', text: '这轮没题。去「题库」加题或让模型生成。' }))
        return
      }
      body.appendChild(h('div', { class: 'sl-sub', text: '答不上就回「学习」看一遍，不丢人——但要自己说出来才算会。' }))
      for (var i = 0; i < qs.length; i++) body.appendChild(renderQuestion(qs[i], answered[qs[i].id]))
    }

    function renderQuestion(q, answeredEntry) {
      var isDone = !!answeredEntry
      var cls = 'sl-q' + (isDone ? (answeredEntry.passed ? ' done-ok' : ' done-bad') : '')
      var box = h('div', { class: cls }, [])
      var tags = []
      if (q.isReview) tags.push(h('span', { class: 'sl-chip rv', text: '旧知识复习' }))
      if (q.angle) tags.push(h('span', { class: 'sl-chip', text: '角度 ' + q.angle }))
      box.appendChild(h('div', { class: 'sl-row' }, [
        h('span', { class: 'sl-id', text: q.id + (q.lessonTitle ? ' · ' + q.lessonTitle : '') + (q.type ? ' · ' + q.type : '') }),
      ].concat(tags)))
      box.appendChild(h('div', { class: 'sl-t', text: q.title }))
      box.appendChild(h('div', { class: 'sl-prompt', text: q.prompt }))

      if (q.hint) {
        box.appendChild(h('details', {}, [
          h('summary', { class: 'sl-btn', style: 'display:inline-block' }, ['卡住了？看提示']),
          h('div', { class: 'sl-sub', text: q.hint }),
        ]))
      }

      if (isDone) {
        box.appendChild(h('div', { class: 'sl-note', text: '已记录：' + answeredEntry.score + '/' + (state.meta ? state.meta.maxScore : 5) + ' ' + (answeredEntry.passed ? '✅ 过关' : '❌ 未过') + (answeredEntry.note ? ' · ' + answeredEntry.note : '') }))
        var cached = state.keys[q.id]
        if (cached) box.appendChild(renderRubric(cached))
        return box
      }

      var ta = h('textarea', { class: 'sl-ta', placeholder: '用你自己的话答（能背关键词但说不出因果 = 2 分）', rows: '4' })
      ta.value = loadDraft(q.id)
      ta.addEventListener('input', function () { saveDraft(q.id, ta.value) })
      box.appendChild(ta)

      var key = state.keys[q.id]
      if (key) box.appendChild(renderRubric(key))

      var scoreRow = h('div', { class: 'sl-row' }, [h('span', { class: 'sl-sub', text: '自评：' })])
      var maxScore = (state.meta && state.meta.maxScore) || 5
      var passScore = (state.meta && state.meta.passScore) || 3
      for (var s = 0; s <= maxScore; s++) {
        (function (val) {
          var label = val === maxScore ? String(val) + ' 满分' : (val === passScore ? String(val) + ' 过关' : String(val))
          var b = h('button', { class: 'sl-btn' + (state.scores[q.id] === val ? ' on' : ''), text: label }, [])
          b.addEventListener('click', function () { state.scores[q.id] = val; render() })
          scoreRow.appendChild(b)
        })(s)
      }
      box.appendChild(scoreRow)

      var noteInput = h('input', { class: 'sl-ta', style: 'min-height:auto;height:30px', placeholder: '记一句缺口（写进答题记录，错题本靠它）' })
      noteInput.value = state.notes[q.id] || ''
      noteInput.addEventListener('input', function () { state.notes[q.id] = noteInput.value })
      box.appendChild(noteInput)

      var actions = h('div', { class: 'sl-row' }, [])
      if (!key) {
        actions.appendChild(h('button', { class: 'sl-btn', onclick: function () { void loadKey(q.id) } }, ['对照判分要点']))
      } else {
        actions.appendChild(h('button', {
          class: 'sl-btn',
          onclick: function () { state.showAnswer[q.id] = !state.showAnswer[q.id]; render() },
        }, [state.showAnswer[q.id] ? '藏起参考答案' : '看参考答案']))
      }
      actions.appendChild(h('button', {
        class: 'sl-btn primary',
        disabled: state.busy[q.id] ? true : false,
        onclick: function () {
          if (state.scores[q.id] === undefined) {
            state.error = q.id + ' 还没选自评分数（0-' + maxScore + '），不给分数不落盘。'
            render()
            return
          }
          void submitOne(q.id)
        },
      }, [state.busy[q.id] ? '写入中…' : '提交并落盘']))
      box.appendChild(actions)

      if (state.showAnswer[q.id] && key && key.answer) box.appendChild(h('div', { class: 'sl-code', text: key.answer }))
      return box
    }

    function renderRubric(key) {
      var wrap = h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, [])
      wrap.appendChild(h('div', { class: 'sl-sub', text: '判分要点（答中几条给几分，3 分过关）：' }))
      var ul = h('ul', { class: 'sl-rubric' }, [])
      var items = key.rubric || []
      for (var i = 0; i < items.length; i++) ul.appendChild(h('li', { text: items[i] }))
      wrap.appendChild(ul)
      if (key.trap) wrap.appendChild(h('div', { class: 'sl-warn', text: '常见错法：' + key.trap }))
      if (key.lesson && key.lesson.body) {
        wrap.appendChild(h('details', {}, [
          h('summary', { class: 'sl-btn', style: 'display:inline-block' }, ['回到学习卡']),
          h('div', { class: 'sl-bodytext', text: key.lesson.body }),
        ]))
      }
      return wrap
    }

    // ---------------------------------------------------------------- 题库 tab
    function renderBank(body) {
      var b = state.bank
      var totals = (b && b.totals) || { questions: 0, lessons: 0, dueNow: 0, attempts: 0 }
      body.appendChild(h('div', { class: 'sl-row' }, [
        h('span', { class: 'sl-chip', text: '题 ' + totals.questions }),
        h('span', { class: 'sl-chip', text: '学习卡 ' + totals.lessons }),
        h('span', { class: 'sl-chip', text: '待复习 ' + totals.dueNow }),
        h('span', { class: 'sl-chip', text: '答题记录 ' + totals.attempts }),
        h('div', { class: 'sl-spacer' }),
        h('button', { class: 'sl-btn', onclick: function () { void loadBank() } }, ['刷新']),
      ]))
      if (state.bankError) body.appendChild(h('div', { class: 'sl-err', text: state.bankError }))
      if (state.importInfo) body.appendChild(h('div', { class: 'sl-ok', text: state.importInfo }))

      // —— 模型生成
      var genSec = h('div', { class: 'sl-sec' }, [h('h4', {}, ['用模型生成'])])
      genSec.appendChild(h('div', { class: 'sl-row' }, [
        h('span', { class: 'sl-sub', text: '数量' }),
        h('input', {
          class: 'sl-in', style: 'width:64px', value: String(state.genCount),
          oninput: function (e) { state.genCount = Number(e.target.value) || 1 },
        }),
        h('input', {
          class: 'sl-in', style: 'flex:1;min-width:160px', placeholder: '主题（可空；空则用全部知识点）',
          value: state.genTopic, oninput: function (e) { state.genTopic = e.target.value },
        }),
        h('button', { class: 'sl-btn primary', disabled: state.bankBusy, onclick: function () { void genQuestions() } }, [state.bankBusy ? '生成中…' : '按提示词生成题目']),
        h('button', { class: 'sl-btn', onclick: function () { void previewPrompt() } }, ['看看提示词']),
      ]))
      genSec.appendChild(h('div', { class: 'sl-row' }, [
        h('input', {
          class: 'sl-in', style: 'flex:1;min-width:160px', placeholder: '输入一个知识点标题，让模型写一张学习卡',
          value: state.lessonTopic, oninput: function (e) { state.lessonTopic = e.target.value },
        }),
        h('button', { class: 'sl-btn', disabled: state.bankBusy, onclick: function () { void genLesson() } }, ['生成学习卡']),
      ]))
      body.appendChild(genSec)

      if (state.promptPreview) {
        body.appendChild(h('div', { class: 'sl-sec' }, [
          h('h4', {}, ['即将发给模型的提示词']),
          h('div', { class: 'sl-code', text: state.promptPreview }),
        ]))
      }

      // —— 导入
      var impSec = h('div', { class: 'sl-sec' }, [h('h4', {}, ['导入题库'])])
      impSec.appendChild(h('div', { class: 'sl-row' }, [
        h('select', {
          class: 'sl-in', onchange: function (e) { state.importKind = e.target.value },
        }, [h('option', { value: 'questions', selected: state.importKind === 'questions' }, ['题目']), h('option', { value: 'lessons', selected: state.importKind === 'lessons' }, ['学习卡'])]),
        h('button', { class: 'sl-btn', onclick: function () { downloadFile('/bank/template?kind=' + encodeURIComponent(state.importKind)) } }, ['下载 CSV 模板']),
        h('button', { class: 'sl-btn', onclick: function () { downloadFile('/bank/export?kind=' + encodeURIComponent(state.importKind)) } }, ['导出 CSV']),
        h('button', { class: 'sl-btn', onclick: function () { downloadFile('/bank/export?kind=progress') } }, ['导出复习进度']),
      ]))
      impSec.appendChild(h('div', { class: 'sl-sub', text: '方式一：粘贴 JSON 或 CSV（首行表头要有「标题」）。方式二：选 Excel/CSV 文件。' }))
      var ta = h('textarea', {
        class: 'sl-ta', rows: '5',
        placeholder: '[{"title":"为什么要自己解析 SSE","lessonTitle":"为什么要自己解析 SSE","prompt":"...","rubric":["...","..."]}]',
      })
      ta.value = state.importText
      ta.addEventListener('input', function () { state.importText = ta.value })
      impSec.appendChild(ta)
      var fileInput = h('input', {
        type: 'file', class: 'sl-in', style: 'padding:3px',
        accept: '.csv,.tsv,.txt,.xlsx,.json',
        onchange: function (e) { void importFile(e) },
      })
      impSec.appendChild(h('div', { class: 'sl-row' }, [
        fileInput,
        h('button', { class: 'sl-btn primary', disabled: state.bankBusy, onclick: function () { void importText() } }, ['导入上面的文本']),
      ]))
      body.appendChild(impSec)

      // —— 列表
      var listSec = h('div', { class: 'sl-sec' }, [
        h('div', { class: 'sl-row' }, [
          h('h4', { style: 'margin:0', text: '题目（' + totals.questions + '）' }),
          h('div', { class: 'sl-spacer' }),
          h('button', { class: 'sl-btn', onclick: function () { state.showQList = !state.showQList; render() } }, [state.showQList ? '收起' : '展开']),
        ]),
      ])
      if (state.showQList && b) {
        var qList = h('div', { class: 'sl-list' }, [])
        for (var i = 0; i < b.questions.length; i++) {
          (function (q) {
            var rv = q.review
            qList.appendChild(h('div', { class: 'sl-item' }, [
              h('span', { class: 'grow', text: q.title }),
              rv && rv.seen ? h('span', { class: 'sl-chip rv', text: rv.dueInMinutes > 0 ? ('复习 ' + Math.round(rv.dueInMinutes / 60) + 'h 后') : '待复习' }) : h('span', { class: 'sl-chip', text: '新' }),
              h('button', { class: 'sl-btn danger', onclick: function () { void deleteItem('questions', q.id) } }, ['删']),
            ]))
          })(b.questions[i])
        }
        if (b.questions.length === 0) qList.appendChild(h('div', { class: 'sl-sub', text: '还没有题。' }))
        listSec.appendChild(qList)
      }
      body.appendChild(listSec)

      var lSec = h('div', { class: 'sl-sec' }, [
        h('div', { class: 'sl-row' }, [
          h('h4', { style: 'margin:0', text: '学习卡（' + totals.lessons + '）' }),
          h('div', { class: 'sl-spacer' }),
          h('button', { class: 'sl-btn', onclick: function () { state.showLList = !state.showLList; render() } }, [state.showLList ? '收起' : '展开']),
        ]),
      ])
      if (state.showLList && b) {
        var lList = h('div', { class: 'sl-list' }, [])
        for (var k = 0; k < b.lessons.length; k++) {
          (function (l) {
            var rv = l.review
            lList.appendChild(h('div', { class: 'sl-item' }, [
              h('span', { class: 'grow', text: l.title + '（' + (l.questionCount || 0) + ' 题）' }),
              rv && rv.seen ? h('span', { class: 'sl-chip rv', text: '档 ' + (rv.streak || 0) + ' · ' + (rv.angle || '') }) : h('span', { class: 'sl-chip', text: '未学' }),
              rv && rv.seen ? h('button', { class: 'sl-btn', title: '清掉复习进度，下次当新知识重新学', onclick: function () { void resetReview(l.id) } }, ['重置']) : null,
              h('button', { class: 'sl-btn danger', onclick: function () { void deleteItem('lessons', l.id) } }, ['删']),
            ]))
          })(b.lessons[k])
        }
        if (b.lessons.length === 0) lList.appendChild(h('div', { class: 'sl-sub', text: '还没有学习卡。' }))
        lSec.appendChild(lList)
      }
      body.appendChild(lSec)
    }

    // ---------------------------------------------------------------- 设置 tab
    function renderSettings(body) {
      var s = state.settings
      if (!s) { body.appendChild(h('div', { class: 'sl-sub', text: '正在读设置…' })); return }
      var sec = h('div', { class: 'sl-sec' }, [h('h4', {}, ['节奏'])])
      sec.appendChild(h('div', { class: 'sl-row' }, [
        h('span', { class: 'sl-sub', text: '每隔' }),
        h('input', { class: 'sl-in', style: 'width:64px', value: String(state.intervalDraft !== null ? state.intervalDraft : s.intervalMinutes), oninput: function (e) { state.intervalDraft = e.target.value } }),
        h('span', { class: 'sl-sub', text: '分钟弹一轮' }),
        h('span', { class: 'sl-sub', text: '每轮' }),
        h('input', { class: 'sl-in', style: 'width:56px', value: String(state.perRoundDraft !== null ? state.perRoundDraft : s.questionsPerRound), oninput: function (e) { state.perRoundDraft = e.target.value } }),
        h('span', { class: 'sl-sub', text: '题，其中旧知识复习' }),
        h('input', { class: 'sl-in', style: 'width:56px', value: String(state.reviewSlotsDraft !== null ? state.reviewSlotsDraft : s.reviewSlots), oninput: function (e) { state.reviewSlotsDraft = e.target.value } }),
        h('span', { class: 'sl-sub', text: '个位置' }),
      ]))
      sec.appendChild(h('div', { class: 'sl-sub', text: '复习间隔阶梯（分钟）：' + (s.ladder || []).join(' / ') + '　分数越高隔越久；未过关回到第一档。' }))
      body.appendChild(sec)

      var m = s.model || {}
      var msec = h('div', { class: 'sl-sec' }, [h('h4', {}, ['模型（OpenAI 兼容端点）'])])
      msec.appendChild(h('div', { class: 'sl-row' }, [
        h('span', { class: 'sl-sub', text: 'baseURL' }),
        h('input', { class: 'sl-in', style: 'flex:1;min-width:200px', value: (state.modelDraft && state.modelDraft.baseUrl !== undefined) ? state.modelDraft.baseUrl : (m.baseUrl || ''), oninput: function (e) { setModel('baseUrl', e.target.value) } }),
      ]))
      msec.appendChild(h('div', { class: 'sl-row' }, [
        h('span', { class: 'sl-sub', text: '模型名' }),
        h('input', { class: 'sl-in', style: 'width:180px', value: (state.modelDraft && state.modelDraft.model !== undefined) ? state.modelDraft.model : (m.model || ''), oninput: function (e) { setModel('model', e.target.value) } }),
        h('span', { class: 'sl-sub', text: 'key 环境变量名' }),
        h('input', { class: 'sl-in', style: 'width:180px', value: (state.modelDraft && state.modelDraft.apiKeyEnv !== undefined) ? state.modelDraft.apiKeyEnv : (m.apiKeyEnv || ''), oninput: function (e) { setModel('apiKeyEnv', e.target.value) } }),
      ]))
      msec.appendChild(h('div', { class: 'sl-row' }, [
        h('span', { class: 'sl-sub', text: 'key' }),
        h('input', {
          class: 'sl-in', style: 'flex:1;min-width:200px', type: 'password',
          placeholder: m.hasKey ? (m.keyFromEnv ? '已从环境变量读到（这里不用填）' : '已保存（改了就覆盖）') : '没配 key：本地端点可以不填',
          value: (state.modelDraft && state.modelDraft.apiKey !== undefined) ? state.modelDraft.apiKey : '',
          oninput: function (e) { setModel('apiKey', e.target.value) },
        }),
      ]))
      msec.appendChild(h('div', { class: 'sl-sub', text: '推荐用环境变量：设 ' + (m.apiKeyEnv || 'DEEPSEEK_API_KEY') + '，插件会自动读。填在这里的 key 只存本机文件。' }))
      body.appendChild(msec)

      var psec = h('div', { class: 'sl-sec' }, [h('h4', {}, ['出题提示词'])])
      psec.appendChild(h('div', { class: 'sl-sub', text: '可用占位符：{count} 题数 / {topic} 主题 / {lessons} 知识点清单 / {angles} 角度列表' }))
      var pta = h('textarea', { class: 'sl-ta', rows: '10' })
      pta.value = state.promptDraft !== null ? state.promptDraft : (s.prompt || '')
      pta.addEventListener('input', function () { state.promptDraft = pta.value })
      psec.appendChild(pta)
      psec.appendChild(h('div', { class: 'sl-row' }, [
        h('button', { class: 'sl-btn', onclick: function () { void resetPrompt() } }, ['恢复默认提示词']),
      ]))
      body.appendChild(psec)

      body.appendChild(h('div', { class: 'sl-row' }, [
        h('button', { class: 'sl-btn primary', disabled: state.settingsBusy, onclick: function () { void saveSettings() } }, [state.settingsBusy ? '保存中…' : '保存设置']),
        h('span', { class: 'sl-sub', text: '数据目录：' + (s.dataDir || '') }),
      ]))
    }

    function setModel(key, value) {
      state.modelDraft = state.modelDraft || {}
      state.modelDraft[key] = value
    }

    // ---------------------------------------------------------------- 动作
    function loadKey(qid) {
      state.busy[qid] = true
      render()
      api('/key?id=' + encodeURIComponent(qid)).then(function (res) {
        state.busy[qid] = false
        if (res && res.ok) state.keys[qid] = res.value
        else state.error = (res && res.error && res.error.message) || '判分要点取不到'
        render()
      })
    }

    function submitOne(qid) {
      state.busy[qid] = true
      render()
      var body = JSON.stringify({ qid: qid, score: state.scores[qid], note: state.notes[qid] || '' })
      api('/submit', { method: 'POST', body: body }).then(function (res) {
        state.busy[qid] = false
        if (!res || !res.ok) {
          state.error = (res && res.error && res.error.message) || '写入失败'
          render()
          return
        }
        clearDraft(qid)
        if (state.round) {
          state.round.answered = state.round.answered || {}
          state.round.answered[qid] = { score: res.value.score, passed: res.value.passed, note: res.value.note, at: '' }
        }
        if (res.value.lesson) {
          state.notice = '下次复习：' + res.value.lesson.dueAt + '（档 ' + res.value.lesson.streak + ' · 角度 ' + res.value.lesson.angle + '）'
        }
        render()
        void refresh()
      })
    }

    function regenerate() {
      api('/regenerate', { method: 'POST', body: '{}' }).then(function (res) {
        if (res && res.ok) applyState(res.value, true)
        render()
      })
    }

    function snooze() {
      api('/snooze', { method: 'POST', body: '{}' }).then(function (res) {
        if (res && res.ok) applyState(res.value, false)
        state.visible = false
        render()
      })
    }

    function dismiss() {
      api('/dismiss', { method: 'POST', body: '{}' }).then(function () { /* 后端会记 skipped */ })
      state.visible = false
      render()
    }

    // ---- 题库动作
    function loadBank() {
      state.bankBusy = true
      state.bankError = null
      api('/bank').then(function (res) {
        state.bankBusy = false
        if (!res || !res.ok) { state.bankError = '题库读取失败：' + ((res && res.error && res.error.message) || ''); render(); return }
        state.bank = res.value
        render()
      })
    }

    function importText() {
      var text = String(state.importText || '').trim()
      if (!text) { state.bankError = '先粘贴 JSON 或 CSV'; render(); return }
      state.bankBusy = true
      state.bankError = null
      api('/bank/import', { method: 'POST', body: JSON.stringify({ kind: state.importKind, text: text }) }).then(function (res) {
        state.bankBusy = false
        if (!res || !res.ok) {
          state.bankError = '导入失败：' + ((res && res.error && res.error.message) || '')
          render()
          return
        }
        state.importInfo = '导入 ' + res.value.imported + ' 条（新增 ' + res.value.added + '，更新 ' + res.value.updated + '）' + (res.value.warnings && res.value.warnings.length ? ' · ' + res.value.warnings.join('；') : '')
        state.importText = ''
        state.bank = null
        void loadBank()
      })
    }

    function importFile(e) {
      var input = e && e.target
      var file = input && input.files && input.files[0]
      if (!file) return
      if (typeof FileReader !== 'function') { state.bankError = '这个环境不支持读文件'; render(); return }
      var reader = new FileReader()
      reader.onload = function () {
        var result = String(reader.result || '')
        var comma = result.indexOf(',')
        var base64 = comma >= 0 ? result.slice(comma + 1) : ''
        if (!base64) { state.bankError = '读文件失败'; render(); return }
        state.bankBusy = true
        api('/bank/import', { method: 'POST', body: JSON.stringify({ kind: state.importKind, filename: file.name, base64: base64 }) }).then(function (res) {
          state.bankBusy = false
          if (!res || !res.ok) { state.bankError = '导入失败：' + ((res && res.error && res.error.message) || ''); render(); return }
          state.importInfo = '从 ' + file.name + ' 导入 ' + res.value.imported + ' 条（新增 ' + res.value.added + '，更新 ' + res.value.updated + '）'
          state.bank = null
          void loadBank()
        })
      }
      reader.onerror = function () { state.bankError = '读文件失败'; render() }
      reader.readAsDataURL(file)
    }

    function genQuestions() {
      state.bankBusy = true
      state.bankError = null
      api('/generate/questions', { method: 'POST', body: JSON.stringify({ count: state.genCount, topic: state.genTopic }) }).then(function (res) {
        state.bankBusy = false
        if (!res || !res.ok) { state.bankError = '生成失败：' + ((res && res.error && res.error.message) || ''); render(); return }
        state.importInfo = '模型生成 ' + res.value.generated + ' 道题（新增 ' + res.value.added + '）' + (res.value.usage ? ' · token ' + res.value.usage.total_tokens : '')
        state.bank = null
        void loadBank()
      })
    }

    function genLesson() {
      var topic = String(state.lessonTopic || '').trim()
      if (!topic) { state.bankError = '先填一个知识点标题'; render(); return }
      state.bankBusy = true
      state.bankError = null
      api('/generate/lesson', { method: 'POST', body: JSON.stringify({ topic: topic }) }).then(function (res) {
        state.bankBusy = false
        if (!res || !res.ok) { state.bankError = '生成失败：' + ((res && res.error && res.error.message) || ''); render(); return }
        state.importInfo = '生成学习卡「' + res.value.lesson.title + '」'
        state.lessonTopic = ''
        state.bank = null
        void loadBank()
      })
    }

    function previewPrompt() {
      api('/generate/preview-prompt', { method: 'POST', body: JSON.stringify({ count: state.genCount, topic: state.genTopic }) }).then(function (res) {
        if (res && res.ok) state.promptPreview = res.value.prompt
        else state.bankError = (res && res.error && res.error.message) || '取不到提示词'
        render()
      })
    }

    function deleteItem(kind, id) {
      api('/bank/delete', { method: 'POST', body: JSON.stringify({ kind: kind, id: id }) }).then(function (res) {
        if (!res || !res.ok) { state.bankError = '删除失败：' + ((res && res.error && res.error.message) || ''); render(); return }
        state.bank = null
        void loadBank()
      })
    }

    function resetReview(id) {
      api('/bank/reset-review', { method: 'POST', body: JSON.stringify({ id: id }) }).then(function (res) {
        if (!res || !res.ok) { state.bankError = '重置失败：' + ((res && res.error && res.error.message) || ''); render(); return }
        state.importInfo = '已重置复习进度'
        state.bank = null
        void loadBank()
      })
    }

    function downloadFile(path) {
      try {
        var a = document.createElement('a')
        a.setAttribute('href', API + path)
        a.setAttribute('download', '')
        if (document.body && document.body.appendChild) {
          document.body.appendChild(a)
          if (a.click) a.click()
          if (a.parentNode) a.parentNode.removeChild(a)
        }
      } catch (err) {
        state.bankError = '下载失败：' + String((err && err.message) || err)
        render()
      }
    }

    // ---- 设置动作
    function loadSettings() {
      api('/settings').then(function (res) {
        if (res && res.ok) state.settings = res.value
        else state.bankError = '设置读取失败'
        render()
      })
    }

    function saveSettings() {
      var body = {}
      if (state.intervalDraft !== null) body.intervalMinutes = Number(state.intervalDraft)
      if (state.perRoundDraft !== null) body.questionsPerRound = Number(state.perRoundDraft)
      if (state.reviewSlotsDraft !== null) body.reviewSlots = Number(state.reviewSlotsDraft)
      if (state.promptDraft !== null) body.prompt = state.promptDraft
      if (state.modelDraft) {
        body.model = {}
        for (var k in state.modelDraft) body.model[k] = state.modelDraft[k]
      }
      state.settingsBusy = true
      api('/settings', { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
        state.settingsBusy = false
        if (!res || !res.ok) {
          state.bankError = '保存失败：' + ((res && res.error && res.error.message) || '')
          render()
          return
        }
        state.settings = res.value
        state.intervalDraft = null
        state.perRoundDraft = null
        state.reviewSlotsDraft = null
        state.promptDraft = null
        state.modelDraft = null
        state.notice = '设置已保存'
        render()
        void refresh()
      })
    }

    function resetPrompt() {
      api('/settings/default-prompt').then(function (res) {
        if (res && res.ok) { state.promptDraft = res.value.prompt; render() }
      })
    }

    // ---------------------------------------------------------------- 状态同步
    function applyState(value, forceShow) {
      if (!value) return
      state.meta = value
      state.nextInMs = Number(value.nextInMs) || 0
      state.nextAt = Date.now() + state.nextInMs
      var incoming = value.round
      if (!incoming) {
        state.round = null
        state.roundId = null
        state.visible = false
        return
      }
      var isNew = state.roundId !== incoming.id
      var showSeq = Number(incoming.showSeq) || 1
      var reshow = !isNew && showSeq !== state.showSeq
      state.round = incoming
      state.roundId = incoming.id
      state.showSeq = showSeq
      if (isNew || reshow) {
        state.keys = {}
        state.scores = {}
        state.notes = {}
        state.showAnswer = {}
        state.busy = {}
        state.notice = null
        state.promptPreview = null
        // 新的一轮必须回到学习 tab：先看讲解再答题，不然就是凭空被考
        if (isNew) state.tab = 'study'
        try { localStorage.setItem(TAB_KEY, state.tab) } catch (e) { /* ignore */ }
      }
      if (incoming.skipped) { state.visible = false; renderFab(); return }
      if (isNew || reshow || forceShow) state.visible = true
    }

    function readTab() {
      try {
        var t = localStorage.getItem(TAB_KEY)
        if (t === 'study' || t === 'quiz' || t === 'bank' || t === 'settings') return t
      } catch (e) { /* ignore */ }
      return 'study'
    }

    // 轮询每 5 秒回来一次，绝大多数时候内容没变。这里给"会改变画面"的字段算个指纹，
    // 没变就直接返回 —— 不重画，正在看的题就不会被弹回顶部。
    function stateSignature() {
      var r = state.round
      var answered = r ? r.answered || {} : {}
      var ids = Object.keys(answered).sort()
      var parts = [
        state.visible ? '1' : '0',
        state.tab,
        r ? r.id : '-',
        r ? String(r.showSeq) : '-',
        r ? (r.skipped ? '1' : '0') : '-',
        r ? ((r.warnings || []).join(';')) : '-',
        ids.join(','),
        state.error || '',
        state.notice || '',
        String(Object.keys(state.keys).sort().join(',')),
        Object.keys(state.showAnswer).filter(function (k) { return state.showAnswer[k] }).sort().join(','),
        state.bank ? String((state.bank.totals || {}).questions) + '/' + String((state.bank.totals || {}).lessons) + '/' + String((state.bank.totals || {}).dueNow) + '/' + String((state.bank.totals || {}).attempts) : '-',
        state.settings ? String(state.settings.intervalMinutes) + '/' + String(state.settings.questionsPerRound) : '-',
        state.lessonView ? String(state.lessonView.id) : '-',
        state.promptPreview ? String(String(state.promptPreview).length) : '-',
      ]
      return parts.join('|')
    }

    function refresh() {
      return api('/state').then(function (res) {
        if (!res || !res.ok) {
          state.error = (res && res.error && res.error.message) || '插件接口不可用（宿主端没加载？）'
          state.sig = ''
          render()
          return
        }
        state.error = null
        applyState(res.value, false)
        var sig = stateSignature()
        if (sig === state.sig) return
        state.sig = sig
        render()
      })
    }

    function startTimers() {
      if (state.poll === null) state.poll = window.setInterval(function () { void refresh() }, POLL_MS)
      if (state.timer === null) {
        state.timer = window.setInterval(function () {
          if (state.nextAt > 0) state.nextInMs = Math.max(0, state.nextAt - Date.now())
          if (!state.visible) return
          var foot = state.card && state.card.querySelector('.sl-foot .sl-sub')
          if (foot) foot.textContent = '下一轮 ' + mmss(state.nextInMs)
          if (state.nextInMs <= 0) void refresh()
        }, 1000)
      }
    }

    function stopTimers() {
      if (state.poll !== null) { window.clearInterval(state.poll); state.poll = null }
      if (state.timer !== null) { window.clearInterval(state.timer); state.timer = null }
    }

    return {
      inject: [],
      apply: function (ctx) {
        var boot = function () {
          try {
            state.tab = readTab()
            injectStyle()
            startTimers()
            void refresh()
          } catch (err) {
            try { console.warn('[study-loop] 挂载失败', err) } catch (e) { /* ignore */ }
          }
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
        else boot()
        if (ctx && typeof ctx.effect === 'function') {
          ctx.effect(function () { return function () { stopTimers() } }, 'study-loop: timers')
        }
      },
    }
  },
})
