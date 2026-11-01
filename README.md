# dsh-study-loop

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/sunhailong123/dsh-study-loop)

> 先学，再考，然后过一段时间换个角度再问一次。

一个给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用的插件：每隔 N 分钟弹出一张浮动卡片，
**先给你讲这一轮要考的知识点（学习 tab）**，你看完了切到 **答题 tab** 自己打分落盘；
答过的知识点会按间隔重复的节奏，**在之后的轮次里换个提问角度重新出现**。

不是"上来就考你"的抽查工具，是一个闭环：**学 → 答 → 记录 → 到点换角度再问**。

## 为什么需要它

大部分"刷题"插件默认你已经学过内容，于是直接把题甩你脸上。真实的困境是：

- 没学过 → 答不出来 → 挫败 → 不做了；
- 学过了 → 没人考 → 一周后忘光。

所以本插件把「学习材料」和「考题」放在同一张卡片里，并且**记住你答过什么**，按天/周级别把旧知识带回来。

## 安装

```bash
dsh plugin --profile web add dsh-study-loop
```

本地开发用链接装（改源码即时生效）：

```bash
dsh plugin --profile web add link:D:\path\to\dsh-study-loop
```

装完刷新页面（F5）即可，下一轮倒计时到点自动弹出。

## 四个 tab

| tab | 干什么 |
|---|---|
| **学习**（默认打开） | 本轮要考的知识点：摘要 + 正文 + 关键要点。**复习卡只给标题**（给全文等于把答案发你），点「翻原卡」才展开 |
| **答题** | 每道题给 textarea（草稿自动存 localStorage）、0–5 自评、备注；`对照判分要点` 看 rubric，`看参考答案` 看 answer/trap；旧知识复习题带金色边和「旧知识复习」角标 |
| **题库** | 三条维护路径全在这里：**模型生成** / **导入（JSON 文本、Excel .xlsx、CSV）** / **逐条删除与重置**；另有导出 CSV 和下载模板 |
| **设置** | 节奏（间隔分钟、每轮题数、复习题配额、过关线）、模型（baseUrl / 模型名 / key 环境变量名 / key）、出题提示词模板 |

## 怎么主动打开（不用等 10 分钟）

三种入口，打开的都是同一个浮层：

| 入口 | 说明 |
|---|---|
| **右下角常驻小按钮** | 浮层收起后，界面右下角留一个 `📚 学习循环 · 还有 N 题` 的胶囊按钮，点一下就弹回来（浮层开着时它自动收走，不叠在卡片上） |
| **`POST /study-loop/api/open`** | 不等节拍、立刻弹当前轮；已经收起的轮次会被重新激活（`skipped` 清掉、`showSeq +1`）。如果当前根本没有轮次，会先现攒一轮 |
| **等自动节拍** | 每 `intervalMinutes` 分钟自动弹一次；上一轮没答完会顺延，不会覆盖 |

「收起」= 这一轮作废（到点出新轮），但右下角按钮还在，随时能点回来。「+10 分钟后」= 只是延后，同批题到点重弹。

## 代码块

学习和答题里都能直接写代码，不需要任何第三方依赖（插件仍然是零 npm 依赖）：

- ` ```lang ` 围栏 → 渲染成带语言标签、复制按钮、超长自动滚动的代码块；
- `` `行内代码` `` → 等宽小胶囊；
- 围栏里做**轻量高亮**：注释、字符串、数字、关键字四种颜色，覆盖 JS/TS、Python、SQL、Go、Java 这类常见关键字表；
- 复制按钮先试 `navigator.clipboard`，失败落 `document.execCommand('copy')`，点了会变成「已复制」。

安全上：正文一律走 `textContent` / `createTextNode`，只有高亮结果（已逐段 HTML 转义过的纯 `<span>`）才用 `innerHTML`，所以 `prompt` 里贴 `<script>` 也只会显示成文本。

````markdown
手写一个 SSE 解析器：

```js
const lines = buf.split('\n')
for (const ln of lines) if (ln.startsWith('data:')) handle(ln)
```

上面这段在学习卡正文、题干、参考答案、判分要点里都能直接用。
````

## 题库怎么维护（三种方式，随便混用）

### 1. 模型生成（推荐）

在「题库」页选好模型 → 填这次的主题（可留空）→ 填要几道 → 「生成」。

- 端点走 OpenAI 兼容 `POST {baseUrl}/chat/completions`，默认 `https://api.deepseek.com/v1` + `deepseek-chat`。
- key 优先读环境变量（默认 `DEEPSEEK_API_KEY`），其次读设置页填的值；**key 只存在本机 `~/.dsh-study-loop/settings.json`，接口返回一律掩码成 `••••后4位`**。
- 提示词模板在「设置」页可改，支持占位符 `{count}` `{topic}` `{lessons}` `{angles}`；生成前可以「预览最终提示词」。
- 生成的题会按 `lessonTitle` 自动挂到已有学习卡上；挂不上的会新建学习卡。

### 2. 导入 Excel / CSV

「题库」页 → 选文件（`.xlsx` / `.csv` / `.tsv`）或直接把内容粘到文本框 → 「导入」。

题目表表头：`标题, 知识点, 题干, 判分要点, 提示, 参考答案, 常见错法, 类型, 角度`
学习卡表表头：`标题, 摘要, 内容, 要点, 标签`

- 表头支持中英别名（`title/标题`、`prompt/题干`、`rubric/判分要点`…），列顺序随意。
- 列表字段（`判分要点 / 要点 / 标签`）用 `|`、换行或 `；` 分隔。
- Excel 支持 `.xlsx`；`.xls` 老格式请在 Excel 里另存为 `.xlsx` 或 CSV。
- 「下载模板」拿到带示例行的 CSV，「导出」把现有数据导出成 CSV。

### 3. 直接贴 JSON

同一个输入框贴 JSON 也行，三种形状都收：

```json
[{ "title": "为什么 SSE 要按行解析", "prompt": "...", "rubric": ["...", "..."], "lessonTitle": "为什么 SSE 要按行解析" }]
```
```json
{ "questions": [ ... ] }
```
```json
{ "lessons": [ { "title": "...", "summary": "...", "body": "...", "keyPoints": ["..."] } ] }
```

## 间隔重复怎么算

不用完整的 SM-2，用一条固定阶梯（分钟）：

```
30 → 180 → 720 → 2880 → 10080 → 43200
（半小时 → 3 小时 → 12 小时 → 2 天 → 7 天 → 30 天）
```

- 过关（≥ `passScore`，默认 3）→ 档位 +1，下次按阶梯往后推；
- 没过 → 回到第一档（30 分钟后）；
- 连续过关到顶就停在 30 天。
- 每轮最多掺 `reviewSlots`（默认 2）道到期旧题，**提问角度每次轮换**（原理 / 反例 / 应用 / 对比 / 排错 / 边界 / 类比 / 取舍），避免你记住答案而不是学会知识。

## 数据存在哪

`~/.dsh-study-loop/`（可用 config 的 `dataDir` 覆盖）：

| 文件 | 内容 |
|---|---|
| `lessons.json` | 学习卡：标题 / 摘要 / 正文 / 关键要点 / 标签 |
| `questions.json` | 题目：题干 / 判分要点 / 提示 / 参考答案 / 常见错法 / 所属学习卡 |
| `progress.json` | 每个知识点的 `streak` / `dueAt` / `angle` / `lastScore`，以及最近 2000 条作答历史 |
| `settings.json` | 节奏、模型配置、出题提示词 |

都是纯 JSON，坏了可以手改；写入走「临时文件 + rename」，不会写一半烂掉。

首次启动时若检测到旧的 `quiz-dojo/bank/w*.json`，会自动播种（`answer` 当学习卡正文、`trap` 当常见错法），**只在 `questions.json` 不存在时做一次，绝不覆盖已有数据**。

## 配置

`cordis.patch.yml` 默认不写 config（数据目录走插件默认值，换机器不用改路径）。要覆盖就在 profile 的 `cordis.patch.yml` 里写：

```yaml
- insert:
    - id: study-loop
      name: 'dsh-study-loop'
      inject: [ webServer ]
      config:
        dataDir: '/custom/dir'
        legacyQuizDir: ''          # 显式空串 = 不播种
        intervalMinutes: 10
        questionsPerRound: 5
```

## HTTP 接口

前缀 `/study-loop/api`，只允许回环地址访问，`POST` body 上限 8MB。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state` | 当前轮（含学习卡、题目、倒计时） |
| GET | `/key?id=` | 某题的判分要点 / 参考答案 / 常见错法 |
| GET | `/lesson?id=` | 学习卡详情 |
| GET | `/bank` | 题库列表与统计 |
| GET | `/settings` | 设置（key 掩码） |
| GET | `/settings/default-prompt` | 默认出题提示词 |
| GET | `/bank/template?kind=questions\|lessons` | 下载 CSV 模板 |
| GET | `/bank/export?kind=questions\|lessons\|progress` | 导出 CSV |
| POST | `/submit` | `{qid, score, note}`，**缺 score 返 400 且不落盘** |
| POST | `/tab` | 切换 tab |
| POST | `/open` | **主动打开**：立刻弹当前轮（`skipped` 清掉、`showSeq +1`）；没有轮次就先攒一轮 |
| POST | `/regenerate` | 换一批 |
| POST | `/snooze` | 本轮 +N 分钟后再弹（不作废） |
| POST | `/dismiss` | 收起本轮（作废，到点出新轮） |
| POST | `/bank/import` | `{kind, text}` 或 `{kind, base64, filename}` |
| POST | `/bank/upsert` | 逐条新增/更新 |
| POST | `/bank/delete` | 删一条 |
| POST | `/bank/reset-review` | 把某知识点打回第一档 |
| POST | `/settings` | 保存设置 |
| POST | `/generate/preview-prompt` | 预览最终提示词 |
| POST | `/generate/questions` | 调模型生成题目 |
| POST | `/generate/lesson` | 调模型生成学习卡 |

## 开发

```bash
npm run typecheck    # node --check 六个文件
npm run selftest     # 宿主 + 纯函数：141 项（含手造 xlsx、CSV、间隔重复、HTTP 端点）
npm run clienttest   # 客户端假 DOM：74 项（四个 tab 的行为、轮询不打断阅读、代码块与复制按钮）
npm test             # 两个都跑
```

自测全部跑在 `%TEMP%` 沙盒里，**绝不碰真实数据目录**。

改了代码让它生效（不用重启桌面端）：本插件以 `link:` 依赖 + junction 装进 profile，
`dsh-hmr` 的 `reconcileProfile()` 会比对模块的 mtime/ctime/size 并热替换；
给它一个触发即可 — 改 profile 的 **`cordis.patch.yml`**（追加一个换行字节，等十几秒，再改回来）。
注意：改 `package.json` 只刷新 bundle 清单，**不会**重载 profile 包的代码：

```powershell
$f = "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"
$b = [IO.File]::ReadAllBytes($f)
[IO.File]::WriteAllBytes($f, $b + [Text.Encoding]::UTF8.GetBytes("`n"))
Start-Sleep 16
[IO.File]::WriteAllBytes($f, $b)
```

浏览器端 URL 带 `rev=`，刷新页面即取新代码。

## 已知边界

- 浮层是自绘 DOM 挂 `document.body`（z-index 2147482900），没走 `shell.overlay` 槽位（那一层 z-index 只有 20）。代价：插件被卸载时浮层不会自动清场，刷新页面即可。
- 代码块只认 ` ``` ` 围栏和反引号行内代码，**不做 markdown 全量**（标题、列表、表格、图片都不渲染）。高亮是按关键字表匹配的轻量实现，不是 AST 级语法分析，排版怪一点不影响读。
- 每 5 秒轮询一次 `/state`，但**状态没实质变化就不重画**；真要重画时也会把 `.sl-body` 的滚动位置还原，所以看着某道题的时候不会被打回顶部（v0.2.1 修的）。
- 判分是**自评**（0–5），不调模型打分。想让模型判分的话，`/submit` 的 `score` 完全可以由外部算好再传。
- 题目/学习卡都存 JSON，一万题以内无压力；作答历史截断到 2000 条。
- 模型生成需要能出网的 OpenAI 兼容端点；本地 Ollama 也能用，把 `baseUrl` 指到 `http://127.0.0.1:11434/v1` 即可（本地地址不校验 key）。

## License

MIT
