# dsh-llm-acp

把本地 **ACP CLI agent**（kiro-cli、codebuddy、opencode、Codex/Claude Code 的 ACP 适配器……）接成 DeepSeek Harness 的 **LLM provider**。

添加 provider 后，这个 CLI 的模型会出现在 DSH 的模型选择器里，引用写作 `<provider>/<model>`（例如 `kiro/gpt-5.6-terra`），像其它模型一样选用。插件本身提供的是**模型路由**和**用量控制台**：

- 左侧栏「ACP 洞察」一级页、右侧栏「ACP 控制台」标签、输入框 `/acp` 三种入口，查看各 CLI 的状态、模型、Token 用量与 TPS
- 顶部「配置 CLI」标签扫描本机已安装的 CLI，检测握手后一键添加或编辑，不用手写 YAML
- 复用 CLI 进程和它自己的原生会话，省掉每轮冷启动

**前提**：本机至少要装一个 ACP CLI（`kiro-cli acp`、`codebuddy --acp`、`opencode acp`、`pi-acp`、`@agentclientprotocol/claude-agent-acp`……），插件自己不提供模型。它不替代 DSH 自己的 Agent / Team 机制，也不给 CLI 增加宿主的工具。

## 界面：模型选择 · 控制台 · 洞察页 · /acp 命令

插件自带一个客户端用量控制台（`client.js`），把每一轮 ACP 调用的提供方、模型、Token、耗时、成败记下来并可视化。它有**三个入口**，看的是同一份数据，只是范围与布局不同：

| 入口 | 在哪 | 范围 | 布局 |
|---|---|---|---|
| **ACP 控制台** 标签 | 右侧栏（`dsh-client-ui-sidebar-right`） | 全部会话 | 窄栏，内部滚动 |
| **ACP 洞察** 一级页 | 左侧一级侧边栏 | 全部会话 | 宽屏整页 |
| **`/acp`** 命令 | 输入框里敲 `/acp` | **锁定当前会话** | 弹窗 |

三个入口都可以单独开关。控制台顶部「入口」一行有三个勾选框：**侧边栏洞察页**、**/acp 命令**、**模型列表按渠道着色**，去掉勾选就即时撤掉对应功能（不用重启）。右侧栏标签始终在。

![右侧栏 ACP 控制台](docs/shot-02-sidebar.png)

*右侧栏控制台：范围切换、入口开关、KPI 与趋势图。窄栏里卡片自动折成单/双列。*

### 在输入框选 ACP 模型（按渠道着色）

添加 provider 后，点输入框右下角的模型按钮，每个 ACP CLI 是一组，组名形如「CodeBuddy (外部 CLI · external CLI)」，组里是这个 CLI 报出来的模型。选中后这个会话就用 `<provider>/<model>` 这条路由。

![在输入框选择 ACP 模型](docs/shot-07-model-picker.png)

*模型列表按渠道着色：渠道名 15px 加粗、用渠道颜色，前面一条同色竖条；每个模型前一个同色圆点。*

- **按渠道着色**：列表里所有渠道（不只 ACP）各用一种颜色。颜色从 12 色里按渠道第一次出现的顺序分配，互不重复，存在浏览器本地，刷新后不变。输入框里的模型按钮也会带上当前渠道的圆点。
- **开关**：控制台「入口」一行的「模型列表按渠道着色」，默认打开，去掉勾选立即恢复原样。
- **实现方式**：只给 DSH 自带的模型选择组件加样式，不替换组件，也不占用 `conversation.input.model.label` 这个只能给一个插件用的插槽。
- **立即更新**：在控制台停用 / 启用渠道、开关模型、重新读取模型、删除渠道后，插件会马上通知 DSH（`llm/models-updated`），打开的模型列表随即刷新，不用等缓存过期。
- 模型名后的「· 0.13x」是积分倍率（codebuddy / kiro-cli 自动读取，见编辑窗口「名字后显示积分倍率」）。

### ACP 洞察一级页

左侧一级侧边栏点「ACP 洞察」打开宽屏整页，适合在大屏上总览所有会话的 CLI 状态与用量。点图表 / 会话行可交叉筛选，会话行的 ↗ 直接打开对应会话。

![ACP 洞察一级页](docs/shot-01-insights-page.png)

**版本号与升级提醒**：

- 标题「ACP 洞察」旁显示当前插件版本（如 `v0.2.4`），点一下会立即重新检查线上版本；鼠标悬停可看到线上最新版本和上次检查时间。右侧栏控制台的标题旁也有一个小号的版本徽标。
- 线上版本由服务端查询（`GET /api/llm-acp.latest`，`?force=1` 跳过缓存），**同时查 npm 和 npmmirror**。DSH 插件管理器从响应更快的那个源安装（国内通常是 npmmirror），而 npmmirror 在发版后要几分钟才同步，所以只有**两边都已经有**的版本才会提示「去升级」，避免点了「更新到 x」却因为镜像还没有这个版本而失败（`ERR_PNPM_NO_MATCHING_VERSION`，然后自动装回旧版本）。
- 镜像落后时，版本号旁显示不带动效的「vX 镜像同步中」，此时每 2 分钟重查一次，同步好后自动变成升级提醒；服务端同时会请 npmmirror 立即同步这个包（最多每 10 分钟一次）。
- 成功结果缓存 30 分钟，失败缓存 5 分钟。查询失败时只显示「线上版本查询失败」，不影响页面其他内容。
- 线上有更新时，版本号旁会出现带流光和扩散光环动效的「发现新版本 vX · 去升级」按钮，点击直接打开「插件 → 已安装 → ACP CLI 模型」详情页，点右上角「更新到 x」即可。更新后请 ⌘Q 完全退出 DSH 再打开，并在页面上 ⌘⇧R 强制刷新。
- `link:` 本地开发安装在插件页没有更新按钮，此时提醒按钮变成橙色，点击后提示在插件目录执行 `git pull`，再重启插件或 DSH。
- **更新内容**：升级按钮旁的「更新内容」会展开新版本的说明。说明写在 `package.json` 的 `releaseNotes`（字符串数组，最多 8 条，每条最多 200 字），npm 返回最新版本时一起带回来，不需要额外请求。
- **稍后提醒 / 跳过此版本**：「稍后提醒」24 小时内不再显示动效；「跳过此版本」直到出下一个版本才再提醒。两种情况下版本号旁都只留一个不带动效的「vX 可更新」，点它照样能去升级。状态存在浏览器 localStorage（`dsh-llm-acp.version-state`）。
- **已升级提示**：更新并重启后，第一次打开页面会出现一次「🎉 已升级到 vX」，并列出这个版本的更新内容，同时也说明新代码已经生效。从 0.2.5 及更早版本升上来时，靠控制台已有的偏好设置判断不是新装。
- **更新没生效的提示**：点「去升级」时会记下目标版本。如果 90 秒后页面仍是旧版本，版本号下方会出现橙色提示「上次更新到 vX 好像没有生效」，并按情况说明原因：服务端已是新版本说明只差刷新或完全重启；镜像还没同步时提示等「镜像同步中」消失；其余情况提示展开插件页「查看安装输出」看报错（`ERR_PNPM_NO_MATCHING_VERSION` / `minimumReleaseAge`）。可以点「重新更新」或「不再提示」，记录 7 天后自动清除。
- **版本不一致提示**：顶部黄色提示带「刷新页面」按钮。服务端比页面新时说明只是浏览器缓存，点一下就好；服务端比页面旧时提示先 ⌘Q 完全重启 DSH。
- **检查时机**：页面在后台时暂停检查；切回页面时，距上次检查超过 5 分钟就立即重查一次。
- **减少动态效果**：系统开了「减少动态效果」时，升级按钮不再有流光、光环、浮动等动画，改为静态显示。

**界面语言**：控制台跟随 DSH 的界面语言（设置 → 语言），切换后立即生效，不用刷新。英文覆盖控制台、洞察页、/acp 弹窗、编辑窗口、悬停提示、确认框和 Markdown 用量报告。翻译在渲染时进行：DOM 元素的文字以及 `title` / `placeholder` / `aria-label` / `alt` 查 `client.js` 里的词典（`EN` 精确匹配、`ENT` 带 `{0}` 占位的模板，以中文原文为键），`value`、`key` 这类拿来做判断的值不翻译；`1.2万` 这类数字显示成 `12k`。没收进词典的文字照常显示中文。`test/i18n.mjs` 会检查占位符一致、译文里没有中文、每个词条都在代码里用到。

### /acp 命令（本会话）

在输入框敲 `/acp` 回车，弹出**锁定到当前会话**的控制台：所有卡片只统计这一个会话，范围默认「全部」历史，顶部有「交叉筛选 · 本会话」横幅。弹窗底部「在右侧栏打开 ACP 控制台」可切到右侧栏看全局；`Esc` 关闭。

![/acp 本会话弹窗](docs/shot-03-session-modal.png)

### 范围与工具条

- **范围**：`今日 / 7 天 / 30 天 / 全部`，外加 `自定义`（起止日期）。`/acp` 弹窗默认 `全部`。
- **环比**：与上一个等长周期对比——KPI 显示环比箭头，趋势图叠一条灰色虚线（上期）。
- **紧凑**：更小间距与字号的紧凑模式。
- **一键报告**：把当前范围（含环比、Top 模型、会话×模型）生成一段 Markdown 用量报告，可「复制全文」。
- **自动刷新**：每 15 秒拉一次数据；旁边「刷新」是手动立即拉。
- **导出 CSV**：导出当前范围的逐轮明细；开了交叉筛选时只导筛选后的，并多出一个「导出全部」按钮导未筛选的整段。

> 自定义区间 / 交叉筛选 / 环比依赖更新后的宿主接口。若顶部出现黄色提示「请重启一次 DSH 生效」，重启一次即可；在那之前展示的是未应用这些选项的数据。

### 交叉筛选

点提供方占比环、模型排行、热力图格子、「按模型」表行、会话×模型的会话行或色块，都会把**整页**筛选到该维度（顶部出现「交叉筛选」横幅，列出当前条件）。「清除筛选」一键还原。`/acp` 弹窗里筛选始终叠加在「本会话」之上，不会丢掉会话锁。

### KPI 与估算条

顶部六张 KPI：**接入 CLI**（启用/总数、几个正常）、**可用模型**（启用/总数）、**轮次**（成功/失败/中断/进程，成功率环）、**输入 Token**（含缓存读）、**输出 Token**（平均每轮）、**平均耗时**（P50/P90）。

KPI 下方是**估算条**：CLI 没回报 token 的轮次按「字符数 ÷ 4」估算，这里写明多少轮是估算、估算占比，以及各模型分别有几轮是估算（表格里带 `*`）。CLI 回报真实值时（如 kiro）直接用真实值。

### 图表卡片

- **每日 Token 趋势**：堆积柱状 / 柱状 / 折线三种图形；维度可切「输入/输出」「模型」「提供方」；可导出 SVG / PNG；点某一天的柱子下钻到当天 24 小时分布；开环比时叠加上期虚线。
- **提供方占比**：按 Token 的环形图，点击某提供方筛选全页。
- **模型排行**：按 Token 的 Top 8，点击筛选。
- **活跃热力图**：近 12 周（84 天）格子，指标可切「轮次 / Token / 失败」。
- **时段分布**：24 小时柱状（范围为今日时显示「今日时段分布」大图）。
- **延迟分布**：成功轮次的 P50 / P90 / 最大值与成功率，附各模型 P90。
- **缓存效率**：读缓存占输入 Token 的比例，附各模型命中率。
- **相对积分消耗**：模型倍率 × Token 的相对成本，附各模型明细（倍率取自模型描述）。
- **模型性价比排行**（整行宽卡，侧边栏和洞察页都有，`/acp` 弹窗里没有）：服务端每 5 分钟采集一次各渠道的模型列表，按积分倍率排名。
  - **分档**：免费（0x）→ 疑似免费（名字带 free 但没给倍率）→ 低（<0.3x）→ 中（<1x）→ 高（≥1x）→ 未知倍率，档内按倍率从低到高排；停用的模型照样列出但置灰。
  - **默认按渠道分组**：不同 CLI 的积分池不通用，倍率不能直接比。可切「全部混排」看全局，卡片会提示只作参考；「只看免费」只留免费和疑似免费。
  - **实际使用质量**：用过的模型附最近 7 天的成功率、平均耗时、限流次数。完成 ≥3 轮且成功率低于 70%，或限流 ≥2 次，会标「⚠ 成功率低」，并排到同档其他模型后面，避免把用不了的免费模型排第一。
  - **渠道状态**：每个渠道显示 正常 / 固定列表 / 采集失败 / 无可用模型 / 已停用，以及上次采集时间；超过 2 个周期没采到的标「数据过期」。
  - **变化记录**：每次采集都和上一次对比，记录新增、下架、倍率变化和新出现的免费模型，保留 7 天；24 小时内出现的新免费模型显示在卡片顶部。
  - **立即重新采集**：让所有已启用的 CLI 马上重新读模型列表，忽略失败退避，在后台跑，卡片每 2 秒刷新进度。
  - 采集怎么省资源：复用模型发现的单飞机制，不另开抓取通道；各 CLI 依次启动，每启动一个间隔 15 秒；这些情况沿用缓存、不启动 CLI：渠道已停用、配置了固定 `models`、在失败退避中、正在跑对话、半个周期内已被别处刷新过。
  - 倍率只有 CLI 报告了才有：codebuddy 从握手的 `_meta.credits` 读，kiro-cli 从 `chat --list-models` 读，其他 CLI 从模型描述里解析（`x0.29 credits`、`0.80x Credit`、只有 `x0.29` 都认）。cursor 不报倍率，归入「未知倍率」。
- **字符吞吐**：输出 Token / 秒，附各模型吞吐。
- **会话 × 模型分布**：哪个会话用了哪些模型。指标可切 Token / 轮次，分组按模型 / 按提供方，视图条形图 / 矩阵表，可导出 SVG / PNG；点会话行筛选全页，↗ 打开该会话。
- **按模型**：模型 / 轮次 / 成功率 / 输入 / 输出 / 平均耗时 / 最近使用，点行筛选。
- **错误类别**：把原始错误码归成「限流 / 额度 / 认证 / 服务端 / 超时 / 传输 / 其他」七类，用堆叠占比条 + 每类次数 / 百分比展示；三处入口（洞察页 / 侧边栏 / `/acp`）都能看到，是一眼看清「429 这类限流有多少次」的地方。一键 Markdown 周报的「异常」段落也带这行分类汇总。
- **错误分布**：按错误码计数（如 `ACP_REFUSAL`、`SESSION_TITLE_TIMEOUT`），点击查看详情。
- **最近调用**：逐轮明细，可按「全部 / 成功 / 失败 / 中断」和模型筛选、关键字搜索；「显示更多」每次再加 30 条；点会话看该会话统计。
- **CLI 用量/额度探测**：动态对每个已接入的 CLI 跑一次只读探测命令，把能查到的用量/账号信息列出来（右上角「刷新」重新探测，结果缓存 5 分钟）。**这不是账户余额**——本机 CLI 没有"查剩余额度"的命令，所以卡片如实标注数据来源：
  - `deveco stats` → 本地累计会话数 / 花费 / Token；
  - `cursor-agent about` → 订阅层级（Free/Pro）+ 当前模型；
  - `qodercli status` → 账号类型；
  - 其它 CLI（codebuddy / kiro / …）无可用命令 → 显示「不支持」。
  - 判断"是不是用完了"的可靠信号仍是调用时返回的 `QUOTA_EXCEEDED` / 429，见「错误类别」卡片。邮箱在展示时已脱敏。
  - 想接其它 CLI 或自定义探测命令：在 provider 上加 `usageCommand: ["子命令", "参数…"]`（输出形如 `标签  值` 或 `标签: 值` 即可被解析），无需改代码。

### 吞吐、耗时与会话指标

- **模型 TPS 趋势**（宽卡，在「字符与吞吐」右边）：每个模型一条线，**5 分钟一格**，右上角切「天 / 周 / 月」，最多看最近 30 天（与页面顶部的范围无关，但跟随交叉筛选）。「月」按 1 小时合并绘制，合并用各格的原始累计值精确计算。空格子不画，断开的地方就是没调用。点图例显示 / 隐藏模型，悬停看时间、TPS、轮数；空心点表示含按字符估算的 Token。第一次打开时如果「天」没数据，会自动换成「周」或「月」。
  - **整轮 TPS** = Σ输出 Token ÷ Σ整轮耗时（按耗时加权，含 CLI 跑工具的时间，比模型纯生成速度低）。
  - **生成 TPS** = Σ输出 Token ÷ Σ(耗时 − 首字时间)，只统计记录了**首字时间**的轮次。首字时间（`firstMs`，写进 `usage.jsonl` 和 CSV）是这次新加的字段，之前的旧记录没有。
  - 数据来自 `GET /api/llm-acp.tps?window=day|week|month`，按查询截断到 30 天，不删原始日志。
- **耗时分布**：成功轮次按 <10 秒、10–30 秒、30 秒–1 分、1–5 分、>5 分 分档，条内按提供方着色。
- **项目排行**：按工作目录（会话的 cwd）统计 Token、轮次和会话数，悬停看完整路径。
- **会话深度**：每会话平均轮数、最长轮数、单轮输入 / 输出与输入:输出比例、轮数分档，以及「第 N 轮的平均输入 Token」柱图，用来看上下文随轮次增长。

### CLI / ACP 提供方卡

每个 provider 一张卡：运行状态（正常 / 有失败 / 异常 / 读取中 / 已停用）、CLI 版本、轮次 / Token / 成功率 / 平均耗时、可用模型进度条。

- 右上**开关**：启用 / 停用整个 provider。停用只是暂时关掉，配置保留，卡片变灰但还在；模型列表里这一组立即消失。
- **管理模型**：展开模型表，逐个开关模型；列有「写法」（`provider/model`，模型引用就这么写）、「倍率」、「轮次」、「Token」、「最近使用」。批量按钮：**全部启用**、**全部停用（保留默认）**、**停用 ≥1x 高倍率**。停用的模型不出现在模型选择器里；仍被引用时这一轮报 `ACP_MODEL_DISABLED`。**开关立即生效，不用重启**。CLI 已不再提供但仍被停用的模型会列出来，可一键恢复。
- **重新读取模型**：立即重新发现该 CLI 的模型目录（否则按 `modelCacheMs` 缓存）。
- **配置详情**：展开看该 provider 的生效配置。
- **编辑配置**：打开编辑窗口改命令、权限、推理强度等，保存后插件自动重载。
- **删除**：确认后把这个 provider 从插件配置里删掉，插件自动重载，卡片和模型列表里都不再出现（和编辑窗口里的「删除」是同一个操作）。已有会话里引用 `<provider>/<model>` 的地方会报错，换个模型即可。本机的 CLI 不受影响，以后可以在「本机 ACP CLI」里重新添加。

### 数据从哪来

- 逐轮用量：`$DSH_HOME/llm-acp/usage.jsonl`（默认 `~/.dsh/llm-acp/usage.jsonl`），每轮一行 JSON，超过 20 MB 轮转一次到 `.1`。CSV 导出与所有图表都读它。
- 会话接回映射：`$DSH_HOME/llm-acp/sessions.json`（见下文「接回原生会话」）。
- 模型性价比排行：`$DSH_HOME/llm-acp/rank.json`，存上次采集的各渠道模型（id / 名称 / 描述 / 倍率）和最近 7 天的变化记录，权限 0600。可用 `rankFile` 改路径，设成 `''` 只存内存。卡片读 `GET /api/llm-acp.rank`（只读内存，不启动 CLI），「立即重新采集」调 `POST /api/llm-acp.rank-refresh`。

## 上架到 DSH 插件市场（维护者）

本插件的市场索引在 [docs/market-index.json](docs/market-index.json)，已经用 DSH 自带的 `parseMarketIndex` 验证过（format 1）。索引里的安装来源是 npm registry：`dsh-llm-acp@0.2.8`，所以用户装好后会收到「更新可用」提示，点更新就是 `pnpm add dsh-llm-acp@新版本`，不需要 Git 凭据。

发布步骤：

1. 把本仓库设为 **Public**（私有仓库不能做公开市场来源，索引 URL 必须匿名可访问）。
2. 在目标 npm registry 上发布：`npm publish`（先 `npm login`；`package.json` 可发布——没有 `private` 字段，`files` 含两种语言的详情文档与预览图，另有 locale、icon、LICENSE）。
3. 把 `docs/market-index.json` 放到一个稳定的 https URL，可用仓库 raw 地址 `https://raw.githubusercontent.com/yingcaihuang/dsh-llm-acp/main/docs/market-index.json`，或启用 GitHub Pages（如 `https://yingcaihuang.github.io/dsh-llm-acp/market-index.json`）。每次发版：
   - 在 `versions` 里加一条新版本，按 SemVer 降序排；
   - 更新 `publishTimestamp`（Unix **秒**）；
   - 保持 `engines.dsh` 与实际兼容范围一致；
   - 用验证器跑一遍 `parseMarketIndex(JSON.parse(...), indexUrl)`。
4. 用户启用实验性插件市场后，把这个索引 URL 加到「设置 → 插件 → 实验性插件 → 自定义插件索引」，就能在「发现」标签页里看到本插件。用户侧的完整步骤见下文「安装 · 四、从 DSH 插件市场安装」。

详情页面：插件页读 `locale/en.json` / `locale/zh.json` 里的 `meta.detail`（[DETAIL.md](docs/DETAIL.md)、[DETAIL.zh.md](docs/DETAIL.zh.md)），图片是同目录的 [preview.svg](docs/preview.svg)。没有启用 `meta.detail` 时会回退到本 README。图标是 [icon.svg](icon.svg)。

> 自动升级说明：市场只对 **npm registry** 来源提供「更新可用 / 更新」；Git commit 来源只能在同一仓库同一目录内更新；本地 `link:` / tgz 装的版本不会自动升级，只能卸载重装。版本豁免不会随插件升级继承。

## 安装（给别人用）

四种方式，按对方的场景选；普通用户推荐第四种「从 DSH 插件市场安装」。**共同前提**：至少要装一个 ACP CLI（`kiro-cli acp`、`codebuddy --acp`、`opencode acp`、`pi-acp`、`@agentclientprotocol/claude-agent-acp`……），本插件自己不提供模型。

### 一、从本地目录装（最快，适合自己两台机器之间搬）

把这个目录整个拷过去（或 `git clone`，**不含** `node_modules`），**先在插件目录里装依赖**，再 link：

```bash
cd /绝对路径/dsh-llm-acp
pnpm install --prod                     # 或 npm install --omit=dev；装上 @agentclientprotocol/sdk 和 zod

cd ~/.dsh/profiles/<profile>
pnpm add link:/绝对路径/dsh-llm-acp     # 路径必须是绝对路径
```

> `link:` 不会替插件装依赖。插件目录里没有 `node_modules` 时，服务端一加载就报 `ERR_MODULE_NOT_FOUND: @agentclientprotocol/sdk`，整个插件起不来，ACP 洞察、右侧栏控制台和 `/acp` 都不会出现。

再把 `dsh-llm-acp` 加进同目录 `package.json` 的 `dsh.profile.bundles`，重启 DSH。

### 二、打成 tgz 传（适合发给别人，对方不用 git）

```bash
# 发起方
npm pack                       # 产出 dsh-llm-acp-<版本>.tgz，约 160 KB：index.js、client.js、lib/、locale/、icon、patch、README、LICENSE

# 接收方
cd ~/.dsh/profiles/<profile>
pnpm add file:/绝对路径/dsh-llm-acp-<版本>.tgz
```

tgz 里**不含 `node_modules`**，`@agentclientprotocol/sdk` 和 `zod` 是插件自己的 `dependencies`，pnpm/npm 会照常装上；`@deepseek-ai/dsh-llm` 是 peer，由宿主提供。

**不要去 `node_modules/` 里手动拷目录**——那会绕过依赖安装，SDK 缺失时插件起不来。

### 三、从 npm registry 安装（适合长期多人用）

维护者先把 `dsh-llm-acp` 发布到 npm registry，对方就能直接 `pnpm add dsh-llm-acp`，`@agentclientprotocol/sdk` 和 `zod` 会作为插件自己的依赖装上；`@deepseek-ai/dsh-llm` 是可选 peer，由宿主提供。装完照上文「装完之后」添加 provider。发布链接见 [npm](https://www.npmjs.com/package/dsh-llm-acp)（发布后可达）。

维护者发版步骤：

1. `npm login` 登录到有 `dsh-llm-acp` 发布权限的账号（`npm whoami` 确认）。
2. `npm version <新版本>` 更新 `package.json` 版本号，确认 `files[]` 覆盖运行时要用的文件（`npm pack --dry-run` 核对；`files` 列了两种语言的详情文档、预览图和市场索引，但不含 README 里的截图）。
3. `npm publish` 发布。
4. 按上文「上架到 DSH 插件市场」更新索引里的 `versions` 和 `publishTimestamp`。

### 四、从 DSH 插件市场安装（图形界面，自动收到更新）

不用敲命令，在 DSH 界面里点几下就能装好，以后有新版本会提示「更新可用」。插件市场目前是 DSH 的**实验性功能**，第一次用要先打开：

1. **启用插件市场**：设置 → 插件 → 打开「实验性插件」，启用 **Experimental custom plugin indexes**（`@deepseek-ai/dsh-experimental-plugin-market-bundle`）。启用后「插件」页会多出 **发现** 标签页；没出现就重启一次 DSH。
2. **添加索引源**：在「自定义插件索引」里添加下面这个 URL（只用加一次，每个 profile 各一份）：

   ```
   https://raw.githubusercontent.com/yingcaihuang/dsh-llm-acp/main/docs/market-index.json
   ```

3. **安装**：切到「发现」标签页，选这个索引源，找到 **ACP CLI models**，点「安装」。确认框里的来源应该是 npm registry 的 `dsh-llm-acp@<版本>`，确认即可。
4. **升级**：以后发了新版本，「已安装」里这个插件会显示「更新可用」，点「更新」就行。

> **已经用 `link:` 或 tgz 装过的，要先卸载再从市场装。** 同名插件只能有一份，市场版会替换本地版本；从本地目录装的版本不会自动升级。开发机上要即时改源码调试，就继续用 `link:`，不要从市场装。
>
> 从市场安装同样要求宿主版本在下文「版本门槛」的范围内，不满足时插件管理器会拦下。

### 装完之后（四种方式都一样）

插件装好后**一个 provider 都没有**（自带配置是 `providers: {}`）。打开「ACP 洞察」或右侧栏控制台，「本机 ACP CLI」卡片会自动扫描一次本机已装的 CLI，选一个点「配置并添加」即可，见下文「扫描本机 CLI，一键添加」。扫描结果不会自动接入，改配置前一定由用户确认。

也可以手写：在 profile 的 `cordis.patch.yml` 里给 llm-acp 写 `providers`（见「配置」一节）：

```yaml
- id: llm-acp
  config:
    providers:
      kiro:
        command: /path/to/kiro-cli     # 必须是绝对路径或能在 PATH 里找到
        args: [acp]
        permission: allow
```

`permission` 默认是 `allow`（可以改文件、跑命令，每次只做单次批准，绝不选「总是允许」）。要只读就写 `read`（只批准读取/搜索类工具）或 `reject`（全部拦下）。

### 版本门槛

- `engines.node >= 22`
- peer 范围：`@deepseek-ai/cordis >=4.0.5 <4.2.0`、`@deepseek-ai/dsh-llm >=0.2.1-rc.2 <0.2.2-0 || >=0.2.2-0 <0.3.0-0`（已在 DSH 0.2.2-rc.3 上验证：cordis 4.1.0、dsh-llm 0.2.2-rc.3）。宿主版本不在范围里时，插件管理器会拦下安装/激活，整个插件不启动。**先在对方机器上跑 `npm test` 确认离线测试全绿**，它不需要任何 CLI，也不需要 token。

### 装上了但「ACP 洞察」不见了

按顺序查：

1. **插件有没有激活**：设置 → 插件里看 `dsh-llm-acp` 是否启用、有没有报版本不满足。宿主的 `@deepseek-ai/cordis` / `@deepseek-ai/dsh-llm` 版本超出上面的 peer 范围时会被拦下。
2. **依赖装了没有**：用 `link:` 装的，插件目录里必须有 `node_modules/@agentclientprotocol/sdk`。没有就在插件目录跑 `pnpm install --prod`，再重启 DSH。
3. **入口开关**：右侧栏「ACP 控制台」顶部的「入口 · 侧边栏洞察页」勾选框，去掉后左侧就没有「ACP 洞察」。这个开关存在浏览器本地，每台机器各自一份，默认是开。

### 对方自检

```bash
npm test                    # 离线 248 项，不花 token、不需要 CLI
```

exit 0 才算装对了。

## 扫描本机 CLI，一键添加（不用手写 YAML）

CLI 不是每次都要配置，所以 **本机 ACP CLI** 卡片默认收起。ACP 洞察页 / 右侧栏控制台顶部工具条有一个 **「配置 CLI」标签**（`/acp` 本会话弹窗里没有）：

- 进入页面后会在后台安静地扫描一次，标签上的数字是**可添加的 CLI 数量**。
- 只要有可添加的 CLI、卡片又是收起的，标签就保持**高亮**：品牌色渐变填充，外圈有旋转的彩色描边和呼吸光晕，每隔几秒扫过一道高光，右上角有闪烁圆点。全部接入后恢复成普通按钮。
- 同时标签下方**一直显示**一个轻轻浮动的**提示气泡**（「✦ 发现 N 个可接入的 CLI · 点这里查看，按推荐配置一键添加」），和标签高亮同进同退。
- 点标签或气泡就展开扫描卡片，展开时气泡和高亮隐藏，收起后恢复；全部 CLI 接入后两者都消失。系统开了「减少动态效果」时不播放动画。
- 点标签展开扫描卡片并滚动过去；卡片右上角「收起」收回。
- 一个 provider 都没配时（刚装好就是这样），卡片始终展开，插件只开控制台、不注册模型路由。

扫描只列出结果，**不会自动接入**；之后要再扫就点「重新扫描」。

![配置 CLI 标签与引导圆点](docs/shot-06-config-tag.png)

*引导状态的「配置 CLI」标签和提示气泡：数字 2 表示有 2 个 CLI 可添加。*

![本机 ACP CLI 扫描卡片](docs/shot-04-discover.png)

*扫描结果：6 个 CLI，4 个已接入（点「编辑配置」），CodeBuddy Code (Intl) 和 OpenCode 可添加（点「配置并添加」）。标签里标出 node 脚本 / 原生程序。*

每张卡片：已接入的点「编辑配置」，未接入的点「配置并添加」，打开同一个编辑窗口：基础配置已按推荐值填好（命令绝对路径、ACP 参数、选模型方式、node 脚本的 `env.PATH`、超时与会话），每项都能改，底部可「检测连接」，「配置预览」里能看到将写入的 YAML。

![添加 provider 的编辑窗口](docs/shot-05-editor.png)

*添加 OpenCode：基础配置已按扫描结果填好，权限默认「允许」。点「检测连接」做了一次 ACP 握手（1.2 秒，5 个模型），并给出选模型方式的建议。*

1. **扫描**：在 DSH 的 PATH、登录 shell 的 PATH（从 Dock 启动时 DSH 看不到 `~/.zprofile` 加的目录）和常见安装目录里找已知 CLI（`lib/discover.js` 的 `RECIPES`：kiro-cli、codebuddy、codebuddy-code、qodercli、deveco、opencode、cursor-agent、pi-acp、claude-agent-acp、codex-acp、gemini）。只跑 `--version`，不启动 ACP。已配置的标「已接入」。
2. **检测**：真跑一次 ACP 握手（initialize → session/new，**不发提示词、不花 Token**），显示模型列表、是否支持图片/接回会话，并判断选模型该走命令行 `--model` 还是 ACP 切换。没登录、参数不对时给出提示。
3. **添加**：可改 provider 名和权限（默认 `allow`），点「添加」。插件通过宿主的 `configEditor` 写入 profile 的 `cordis.patch.yml` 并自动重载：先按插件加载时的同一套规则校验整份配置，失败不落盘。`#!/usr/bin/env node` 的脚本会自动补 `env.PATH`。

不在列表里的 CLI 用卡片底部的「手动添加」：填绝对路径和 ACP 参数，**检测成功后**才能添加。

> 注意：`configEditor` 会整体替换 `llm-acp` 这一行的 `config`，那一段里的 YAML 注释会在第一次通过界面保存时丢失。

## 配置

```yaml
- id: llm-acp
  name: dsh-llm-acp
  config:
    rankIntervalMs: 300000                    # 模型性价比排行的采集间隔，默认 5 分钟；0 = 只在点「立即重新采集」时采集；最小 60000
    providers:
      kiro:                                   # ← provider 名，模型引用写 kiro/<model>
        displayName: Kiro
        command: /Users/you/.local/bin/kiro-cli  # 建议绝对路径；裸名走 DSH 进程的 PATH，从 Dock 启动可能找不到（ACP_SPAWN）
        args: [acp]
        modelArgs: ["--model", "{model}"]     # model 是 "default" 时不传
        permission: allow                     # 默认值；只读就改成 read 或 reject
      codebuddy:                              # 已验证：ACP 建会话约 0.6s，24 个模型
        displayName: CodeBuddy
        command: /opt/homebrew/bin/codebuddy
        args: [--acp]
        modelArgs: ["--model", "{model}"]
        permission: allow
```

**已实测的 CLI**：

| CLI | 建会话 | 模型数 | 真实 usage |
|---|---|---|---|
| `kiro-cli acp` | ~3.2s | 19 | ✅ |
| `codebuddy --acp` | ~0.6s | 24 | ✅ |
| `opencode acp` | ~1.9s | 8（免登录） | ✅（含缓存读，偏大） |
| `pi-acp`（pi 0.85.1） | ~1.3s | 4 | ✅ |
| `codebuddy-code --acp`（国际站） | ~1.2s | 26 | 需单独登录 |
| `cursor-agent acp`（2026.05.28） | ~0.4s（建会话 ~7s） | 48 | ✅（仅 Auto / default） |

**Cursor CLI（`cursor-agent`）**：先 `cursor-agent login` 在浏览器登录一次（凭据进 macOS 登录钥匙串；若报 `keychain is locked`，先 `security unlock-keychain ~/Library/Keychains/login.keychain-db`）。它的 ACP **不支持** `session/setConfigOption`，所以只能用启动参数 `--model` 选模型（默认 `modelArgs`）。Free 账号除 Auto 外都会返回 `Upgrade your plan`，因此配置里 `models: [ default ]`（default 不传 `--model`，Cursor 自动用 Auto）：

```yaml
      cursor:
        displayName: Cursor
        command: /path/to/cursor-agent
        args: [ acp ]
        models: [ default ]                 # Free 账号只有 Auto 可用
        permission: allow
```

付费账号可在 Cursor 里确认可用模型名后，把 `models` 改成对应名（如 `composer-2.5`）。ACP 的 model 选项里 `default[]`=Auto，其余带 `[context=…,fast=…]` 后缀。

**CodeBuddy 国际版 / 中国版**：`codebuddy`、`codebuddy-code`、`cbc` 是同一个 CLI，站点只由环境决定，所以要接国际版就再配一个 provider，用 `env` 区分：

```yaml
      codebuddy:                              # 中国站 codebuddy.cn
        command: /path/to/codebuddy
        args: [--acp]
        env: { CODEBUDDY_INTERNET_ENVIRONMENT: internal }
      codebuddy-code:                         # 国际站 codebuddy.ai（gpt-6-*、gemini、grok …）
        displayName: CodeBuddy Code (Intl)
        command: /path/to/codebuddy-code
        args: [--acp]
        env:
          CODEBUDDY_INTERNET_ENVIRONMENT: external          # external = International Site
          CODEBUDDY_CONFIG_DIR: /Users/<you>/.codebuddy-intl # 独立登录态，不覆盖中国版
```

- 只写 `CODEBUDDY_CONFIG_DIR` 不够：CLI 会从已有登录态推断回 `internal`；必须显式 `external`。
- 国际站要在这个目录下**单独登录一次**：`CODEBUDDY_INTERNET_ENVIRONMENT=external CODEBUDDY_CONFIG_DIR=~/.codebuddy-intl codebuddy-code`，进去后 `/login` 选 *International Site*（Google/GitHub）。
- 没登录时模型列表照样能拿到，但第一轮会 `401 … target: https://www.codebuddy.ai`；走 ACP 时 CLI 只回 `stopReason: refusal`，插件报 `ACP_REFUSAL` 并提示检查登录。

| 键 | 默认 | 说明 |
|---|---|---|
| `command` | 必填 | CLI 的路径 |
| `args` | `[]` | 进入 ACP 模式的参数 |
| `modelArgs` | `["--model","{model}"]` | 怎么把 `<provider>/<model>` 里的 model 传给 CLI；`[]` 表示不传 |
| `models` | 自动发现 | 静态模型列表。不填就起一次会话读 `session/new.models`，缓存 10 分钟；发现失败时退回只有 `default` |
| `permission` | `allow` | `allow` 时只选 `allow_once`，**绝不选 `allow_always`**。CLI 自己的权限模式也会被对齐（见下文"权限"） |
| `approvals` | `modes` | `modes`：对齐 CLI 自己的权限模式。`none`：该 CLI **从不询问**（它的 `modes` 装的是别的东西），此时 `permission: reject` 直接拒绝启动而不是假装拦得住。与 `approvalModes` 互斥 |
| `env` | `{}` | 追加给子进程的环境变量 |
| `usageCommand` | 内置配方 | 用量探测命令的 argv（如 `["stats"]`），覆盖内置配方；用于「ACP 洞察」的用量卡片。只读、带超时 |
| `startupTimeoutMs` | 60000 | spawn → initialize → session/new 的总时限 |
| `promptTimeoutMs` | 1800000 | 一轮的总时限 |
| `idleTimeoutMs` | 600000 | 多久没有任何 update 就判卡死 |
| `maxRetries` | 0 | **默认不重试**：CLI agent 有副作用，重放一轮可能把文件改两遍 |
| `startupRetries` | 1 | **只**在启动阶段（尚未发 prompt、无副作用）失败时重试 0–3 次 |
| `reuseSessions` | true | 同一个人会话复用同一个 CLI 进程，省掉每次 ~3.2s 冷启动；设 false 退回每次新进程 |
| `sessionIdleMs` | 1800000 | 热会话空闲多久后回收（30 分钟：同一会话里隔一会儿再提问也不丢 CLI 自己的上下文） |
| `maxSessions` | 8 | 每个 provider 最多同时保持几个热会话（LRU）。**成员数超过它就会抖动**：每轮都要回收一个别人正想用的热会话，等于每轮都冷启动；发生回收时会打一条 `cache/evict` 警告，看到它就调大这个值 |
| `modelDiscoveryBackoffMs` | 60000 | 模型发现失败后的退避窗口（窗口内不再重启 CLI）；整数 ≥ 0，0 表示不退避 |
| `promptRetries` | 2 | 仅当本轮**还没产出任何文本**且失败属限流/服务端/超时/传输时才重试；已产出绝不重放。0–3 |
| `retryDelayMs` | 2000 | 退避间隔基数：限流用**指数退避**（`×2^n` ±10% 抖动，封顶 60s）并优先采用 CLI 文本里的 `Retry-After`；服务端/超时/传输错误按 `×3^n` 递增（默认约 2s、6s、18s，±10% 抖动，封顶 30s）。详见下方「429 与异常处理」 |
| `resumeSessions` | true | CLI 声明 `loadSession` 时，进程被回收/挤掉或 DSH 重启后用 `session/load` 接回 CLI **自己的原生会话**，只发新增消息；设 false 退回重发整段 transcript |
| `mode` | 不设 | 新建/接回会话后切到 CLI 提供的某个 ACP mode，例如 kiro 的 `kiro_planner`、codebuddy 的 `plan`。id 不存在会启动失败并列出可选值。**`permission: reject` 永远优先**，mode 不能绕过它 |
| `images` | true | CLI 声明 `promptCapabilities.image` 时，**向宿主报告该模型支持图片**（`inputModalities: [text, image]`，否则宿主在界面上就拒收图片），并把新消息里的图片作为真正的 ACP 图片块发过去；读不到就退回文字占位。能力第一次查询时问一次 CLI，之后缓存；CLI 起不来时按 `modelDiscoveryBackoffMs` 退避，不会每轮都重启它。发出去的图片在文字记录里标为"attached as image N"，没发出去的才标"not visible" |
| `maxImageBytes` | 4000000 | 单张图片上限（宿主按此压缩） |
| `maxPromptChars` | 400000 | 拼成文本后的上限，超出就从中间裁旧消息 |
| `contextWindow` | 200000 | 报给宿主的上下文窗口 |

### 429 与异常处理

模型调用失败时，插件按下面的链路处理。**只重试「还没吐出任何文本」的整轮失败**——一旦开始输出（可能已经跑过 CLI 工具、产生副作用）就绝不重放。

1. **分类**（`lib/errors.js`）：把 CLI 报错归一化成稳定 code。`429 / rate limit / too many requests / overloaded / throttled / capacity` → `RATE_LIMIT`；`5xx / service unavailable / upstream failure / bad gateway` → `SERVER`；`401/403 / unauthorized` → `AUTH`；`quota / 余额不足 / usage limit` → `QUOTA_EXCEEDED`。后两者是**永久错误，不重试**。
2. **重试**（`promptRetries`，默认 2，最多 3）：仅 `RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT` 这几类瞬时错误、且本轮无任何输出时才重试。
3. **退避**（`retryDelayMs`）：
   - 限流走**指数退避** `base × 2^n`，带 ±10% 抖动避免并发成员同时重试，封顶 60s；若错误文本带 `Retry-After: 30`、`retry after 30s` / `retry in 500ms`，优先采用（封顶 120s）。
   - 服务端 / 超时 / 传输错误按 `base × 3^n` 递增（默认约 2s、6s、18s），带同样的 ±10% 抖动，封顶 30s，给上游短暂中断留出恢复时间。`Error streaming response` 也归为 `SERVER`。
4. **耗尽**：重试用尽后以一条 finish 结束，消息写明「模型调用触发限流（429），自动重试 N 次后仍失败」或「上游模型服务临时异常……不是插件故障，稍后直接重发即可」这类中文提示；原始 `code` 保留，控制台「错误分布」卡片仍按 `code` 统计，`RATE_LIMIT` 失败照常计入。

想更激进就调大 `promptRetries` / `retryDelayMs`。限流期间反复冷启动代价高，优先调大退避而不是重试次数。控制台里失败轮次会带 code 标签，点「错误分布」可看每类错误的次数与最近详情。

## 工作方式

默认**复用热会话**（方案 B）：同一个宿主会话连续调用时，CLI 进程保留下来，只付一次冷启动（实测约 3.2 秒）。热会话里只有"新增的消息"会被发送，开头只带一行简短标记（完整前导说明只在冷启动第一轮发）；CLI 自己上一轮的回复若被宿主原样回传，不再发回给它——除非那条回复里还带着宿主工具调用（CLI 调不了宿主工具，吞掉就等于隐去了它没做过的事，这种会原样发出）。宿主重放的历史若与热会话不一致（回退/压缩/换话题），或没有任何新消息，会自动丢弃热会话并重建。中断、出错或宿主提前停止读取的热会话也会被丢弃，不再复用。

```
stream() → [有热会话则复用 / 否则 spawn CLI → initialize → session/load(记录的 id, 能接回时) 或 session/new(cwd=会话工作目录)
            → (mode) → 权限模式对齐]
        → session/prompt(新增消息拼成的文本 + 图片块)
        ← agent_message_chunk → text-delta
        ← agent_thought_chunk → reasoning-delta
        ← tool_call           → 一行 reasoning 文本 "[CLI tool: …]"（不会变成宿主的 tool-call）
        ← PromptResponse      → usage + finish
        → 拆除：session/cancel → stdin EOF → SIGTERM → SIGKILL（每一步都有超时）
```

### 接回原生会话（`session/load`）

热会话只是省启动时间；真正的上下文（CLI 读过的文件、跑过的工具、它自己的压缩）在 **CLI 自己的会话**里。CLI 声明 `agentCapabilities.loadSession` 时，每轮干净结束后把 `宿主会话 → CLI 会话 id`（外加历史和上一条回复的 **sha256 摘要**，不存对话原文）记到 `$DSH_HOME/llm-acp/sessions.json`（默认 `~/.dsh/llm-acp/sessions.json`，可用插件配置 `stateFile` 改；7 天过期，最多 500 条）。之后进程被回收、被挤掉或 DSH 重启，下一轮就 `session/load` 接回去，只发新增消息。

不会比以前更差，任何疑点都退回"新会话 + 整段 transcript"：
- 宿主历史已经不是 CLI 当时收到的那段的延续（回退、压缩、换话题）⇒ 不接；
- `session/load` 报错，或者**成功了但一条旧消息都没回放**（实测 codebuddy 对不存在的 id 就是这样）⇒ 视为失败；
- 被中断、出错的一轮不记录。

`session/load` 时 CLI 会把旧对话当通知回放一遍，这些**全部丢弃**，不会再显示一遍。

实测（2026-10-28）：kiro 2.24.1、codebuddy 都声明并支持；杀掉进程、新进程接回后都记得上一轮的暗号，且第二轮只发了 150 字符。

### 权限

有的 CLI 默认就在"不询问"模式下跑——实测 codebuddy 新会话的当前模式是 `bypassPermissions`，它根本不会发权限请求，`permission: reject` 本来拦不住它。现在启动时按 ACP 标准（`modes` 或 `category: mode` 的 configOption）对齐：

| `permission` | CLI 当前在跳过确认的模式（`bypassPermissions`/`fullAccess`/`dontAsk`/`auto`…） | CLI 本来就会询问 |
|---|---|---|
| `reject` | 切到会询问的模式（`default` 等）；没有这种模式或切换失败 ⇒ **拒绝启动** | 不动 |
| `allow` | 收窄到 `acceptEdits`（没有就切到会询问的模式，再由插件答 `allow_once`） | 不动 |

只按 mode id 匹配，认不出的 id 一律不选。切换会打一条 `permission` 日志。

**模式名含义不一样的 CLI 用 `approvalModes` 声明**（0.1.6）。内置清单按 Claude 系命名，Codex 不一样：`read-only` 改文件前询问；`auto` 在工作区内**直接改文件、跑命令不询问**（越界/联网才问），相当于 `acceptEdits`；`full-access` 什么都不问。实测 `reject` 时若把 `auto` 当成安全模式，Codex 照样改了文件。这种 CLI 在配置里写明三类 id，内置清单就整体不用：

```yaml
codex:
  approvalModes: { ask: [read-only], edit: [auto], bypass: [full-access] }
  mode: auto          # 可在工作区内改文件、跑命令；越界/联网才问（由插件答 allow_once）
  permission: allow
```

声明后：`reject` 只认 `ask` 里的模式为安全，否则切到第一个可用的 `ask`；`allow` 不会停在 `bypass` 里。同一个 id 只能出现在一类，`ask` 必填。

**有的 CLI 的"会不会询问"不在模式里，而在它自己的配置里。** opencode 的 `build` 模式照
**opencode 自己的 `permission` 配置**行事：默认不问，实测 `build` 下它一次权限请求都不发就把文件写了。
所以 `approvalModes` 必须和一份"全部设成 ask"的 CLI 配置成对出现，靠 `env` 指过去：

```yaml
opencode:
  env: { OPENCODE_CONFIG: /path/to/ask.json }     # {"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}
  approvalModes: { ask: [build, plan] }           # build 会询问——前提是上面那行在
  mode: build
  permission: allow
```

**只写 `approvalModes` 不给那份配置，等于向插件谎报它会询问**，`permission: reject` 就形同虚设。
这个耦合插件查不出来（它只看得到模式 id），所以只能靠配置本身保证；
离线测试里钉了一条用例，说明不声明 `approvalModes` 时 `reject` 认不出 `build`、只能原地保留。

**有的代理根本没有权限模式。** 它的 ACP `modes` 装的是别的东西，而且它从不发
`session/request_permission`。pi-acp 就是这样：`modes` 是**思考档位**
（`off / minimal / low / medium / high / xhigh`），唯一那个 mode 样的 configOption 是
`category: thought_level`，没有 `category: mode`。
内置启发式会把认不出的模式 id 当成"会询问"，于是这种代理在 `permission: reject` 下被当成安全的——
2026-10-29 实测：`reject` 的那一轮零权限请求、文件照样写出来了。
这种代理在配置里写 `approvals: none`（0.1.9）：

```yaml
pi:
  approvals: none           # 这个代理从不询问；permission: reject 会被直接拒绝，而不是假装拦得住
  permission: allow         # 唯一可用的取值
  mode: off                 # 这里的 mode 是思考档位，不是权限模式
```

声明之后：

- `permission: reject` ⇒ **拒绝启动**，报 `ACP_PERMISSION`，消息说明它没有会询问的模式；
- `permission: allow` ⇒ 跳过模式对齐，日志写 `agent never asks (approvals: none)`；
- `mode:` 照常生效（对 pi 是选思考档位），和权限两回事。

`approvals` 只有 `modes`（默认，对齐代理自己的权限模式）和 `none` 两个取值，
**和 `approvalModes` 互斥**——一个说"这些模式会询问"，一个说"没有模式会询问"，同时写是自相矛盾，直接报错。

### 模型怎么选

默认把模型写进命令行（`modelArgs`，默认 `--model {model}`）。但有的 ACP 代理**没有 model 参数**——
Claude Code 的适配器对未知参数直接忽略，传 `--model` 不报错也不生效，会静默跑 CLI 的默认模型。
这种代理在 ACP 里用 `category: model` 的 configOption 暴露模型，用 `modelVia: configOption`（0.1.7）：

```yaml
claude:
  modelVia: configOption     # 建会话后用 session/set_config_option 选模型，命令行不带 --model
  models: [ opus, sonnet, haiku, fable ]
```

规则：

- `modelVia: configOption` 时 `modelArgs` **整段不生效**（不会把无意义的参数塞给 CLI）；
- 模型名写 `default` ⇒ 不发选择，跟随 CLI 自己配的模型；
- 代理不认这个模型、或根本没有 model 这个 option ⇒ 报 `ACP_MODEL` 并列出它支持的，不静默降级；
- 选模型排在 `mode` 和 `permission` **之前**，所以 `permission` 依然说最后一句话；
- CLI 没有 `models` 扩展时，**模型目录就从这个 configOption 读**，所以不写 `models` 也能列出来；
- 一个会话里 model 和 mode 两个 configOption 同时存在时（opencode 就是，而且 model 在前），
  按 `category` 认，不按顺序认——两套逻辑不会抢对方的 option（有离线用例）。
- 顺带：模型发现（`listModels`）现在除了 ACP 的 `models` 扩展，也会读 `category: model` 的
  configOption，所以这类 CLI 不写 `models` 也能列出模型。

**插件自身被重载/停用时**（例如改了 `cordis.patch.yml` 里 llm-acp 的配置），正在跑的这一轮报 `DISPOSED`："llm-acp was reloaded or stopped…"，不再误报成 CLI `exited unexpectedly (exit code 0)`。注意：**正跑在 CLI 模型上的会话里不要改 llm-acp 配置**，热重载会结束这一轮。

工具被拒后，有的 CLI 会自己以 `cancelled` 结束这一轮（实测 codebuddy）。这不是用户中断，所以报成错误 `ACP_PERMISSION`，并写明被拒的工具和改法（`permission: allow`）。

## ⚠️ 已知局限（设计上就有的，不是 bug）

1. **CLI 用不了宿主的工具**，只能用它自己带的工具。任务指令要直接写在发给它的 prompt 里；它不会去读取宿主的会话/任务机制。它拿到的是由宿主投影后的一段文本（以及新增消息里的图片），上下文边界见下面第 2 条。
2. **第一次（或接不回时）历史是拼成一段文本给它的**，不是真正的多轮对话：以前的工具调用和结果都变成纯文本。之后热会话或 `session/load` 接回原生会话，就只发新增部分。CLI 不支持 `loadSession`、或宿主历史被压缩/改写时，仍会退回整段 transcript。
3. **冷启动成本**：kiro 启动约 3.2 秒，**复用后只付一次**。但模型本身偶发很慢（见过单轮 80 秒），所以整体时长波动大。
4. **token 用量**：CLI 回报就透传真实值（kiro 会报），不回报才退回按字符数 ÷ 4 估算。
5. **图片**：只发**新增消息**里的图片，且仅当 CLI 声明支持；之前轮次的图片 CLI 已经在自己的会话里了。不支持时只留一行占位说明。实测 kiro 直接看图；**codebuddy 要先调它自己的 `ViewImage` 工具**，所以在 `permission: reject` 下这一轮会以 `ACP_PERMISSION` 失败，要看图就得 `allow`。
6. **CLI 中途不能问人**：权限请求由插件按配置自动回答，没有人在场。
7. **有的 CLI 根本不能只读**（`approvals: none`，目前是 pi-acp）：它没有会询问的模式，`permission: reject` 只能拒绝启动。要用它就等于给它写权限，没有中间档。
8. **pi-acp 会在每个新会话的开头插一段启动信息**（实测 `"pi v0.85.1\n---\n"` 出现在助手文本最前面）。这是 pi-acp 自己发的 `agent_message_chunk`，插件不按 CLI 名字特判、所以不过滤。要去掉就在 pi 的设置里写 `quietStartup: true`（`~/.pi/agent/settings.json` 或项目里的 `.pi/settings.json`）——实测加上之后第一轮的文本就只有答案了。

## 测试

```bash
npm test   # 离线 248 项，不花 token、不需要 CLI，依次跑：
           #   discover / quota-probe / dashboard-async
           #   errors-port / backoff-port / models-cache-port
           #   credits-port / effort-port / askuser-port / usage-metrics
```

### 重新生成截图

`docs/shot-*.png` 由脚本按**当前 profile 的配置**生成，界面和 DSH 里看到的一致：

```bash
REACT_UMD_DIR=<带 React 18 UMD 的 node_modules> YAML_FROM=<带 js-yaml 或 yaml 的目录> \
  NODE=/usr/local/bin/node <装了 playwright 的 python> scripts/screenshots/shoot.py
```

截图里的家目录默认显示成 `/Users/you`（`SHOTS_MASK_HOME=0` 显示真实路径）；「检测连接」发出的请求会换回真实路径，所以照样能找到 CLI。

- `scripts/screenshots/server.mjs` 起一个本地预览服务器：读 profile 里 `llm-acp` 的配置，直接用插件自己的路由（`lib/dashboard-host.js`）回答 `api/llm-acp.*`，页面用 React 18 UMD 渲染 `client.js`。
- `shoot.py` 等所有卡片读完后，用本机 Google Chrome 无头模式截 6 张：「配置 CLI」标签、洞察页整页（先点开扫描卡片）、右侧栏、`/acp` 弹窗、扫描卡片、编辑窗口（会对第一个「可添加」的 CLI 点一次「检测连接」）。
- **不发提示词、不写配置**：模型列表靠 ACP 握手读取；会话、偏好、用量文件先复制到临时目录再读；预览里点保存会直接报错。
- 需要：Node ≥ 22、`js-yaml` 或 `yaml`（`YAML_FROM` 指向带它的目录）、React 18 UMD 构建（`REACT_UMD_DIR`，找不到会直接报错）、Python Playwright 和本机 Google Chrome。

## 日志

新增结构化日志（`lib/log.js`），每轮一行 JSON，可直接 grep：

```
{"ns":"llm-acp","level":"info","event":"turn","provider":"kiro","model":"claude-haiku-5.5",
 "session":"abc","phase":"done","ok":true,"ms":7156,"chars":433}
```

密钥类字段自动 `[redacted]`，长文本裁到 200 字符，日志写失败不影响对话。

## 依赖

`@agentclientprotocol/sdk@1.4.0`，和官方 dsh-subagent-acp 用的是同一个；还有 `zod`（SDK 的 peer）。
两个都由**插件自己声明**，并 vendored 在 `node_modules/` 里，不依赖宿主 asar 里碰巧有 zod。
