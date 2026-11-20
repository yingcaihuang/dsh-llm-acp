# DSH 插件更新机制与发版参考

> 适用范围：用 npm 发布、在 DSH 插件市场上架的第三方 bundle 插件。
> 依据：2026-11-20 读取的本机 DeepSeek Harness Desktop 内置源码（`app.asar` 里的 `@deepseek-ai/dsh-plugin-manager`、`dsh-client-ui-plugin-manager`、`dsh-plugin-market`、`dsh-client-ui-plugin-market`），以及 [dsh-connect-workbuddy](https://github.com/dingminhua/dsh-connect-workbuddy) 的发布与文档做法。DSH 升级后行号可能变化，判断逻辑以当时源码为准。

## 1. 结论速览

- **「可更新」「有新版本」只是标记，不代表一定有更新按钮。** 标记只比较版本号；按钮出不出现，取决于插件**当初是怎么装的**。
- 第三方插件常规的一键更新入口只有一个：**设置 → 插件 → 已安装 → 点进插件详情页 → 右上角「更新到 x.y.z」**。前提是插件以 **registry 规格、按它自己的包名** 安装（profile 里记录成 `"dsh-llm-acp": "0.2.0"` 这种形式）。
- **「发现」页**只给「用 Git 固定 commit 安装」的插件显示「更新」按钮。来源是 npm 的条目只显示「有新版本」文字，没有按钮。
- **`link:` 本地开发安装**在两个页面都不会有更新按钮，这是 DSH 的设计，不是插件的问题。

## 2. DSH 怎么判断（源码依据）

### 2.1 宿主：这个插件能不能被更新

`dsh-plugin-manager/src/index.ts` 的 `updateRefusal()`（约 L185–204）决定插件的 `update` 字段（定义见 `src/types.ts` L106–112）：

1. 必须是本 profile 安装的第三方依赖：`installed`、`availability === 'profile'`、非官方、有 `source`。
2. 不能是带插件管理能力的 bundle（不可卸载就不可替换）。
3. `package.json` 的 `version` 必须是合法 semver。
4. 来源是 **Git 且固定到完整 commit** → `update: 'git'`。
5. 来源是 **registry 规格、名字就是包名本身**（不是 `npm:` 别名）→ `update: 'registry'`。
6. 其他情况（`link:`、`file:`、tarball、别名等）→ 没有 `update`，拒绝原因是 *installed neither from a registry under its own name nor from a Git commit*。

| 安装方式 | profile `package.json` 里的值 | `update` | 已安装详情页 | 发现页 |
|---|---|---|---|---|
| npm，按自己的包名 | `"dsh-llm-acp": "0.2.0"` | `registry` | ✅「更新到 x」 | 只有「有新版本」文字 |
| Git，固定完整 commit | `github:owner/repo#<40 位 commit>` 之类 | `git` | 从版本列表发起 | ✅「更新」按钮 |
| 本地链接 / 本地目录 | `link:/Users/...`、`file:...` | 无 | ❌ | 只有文字 |
| `npm:` 别名、改名安装、tarball | `npm:other@1.0.0` 等 | 无 | ❌ | 只有文字 |

### 2.2 「已安装」页

`dsh-client-ui-plugin-manager/src/client/PluginManagerPage.tsx`：

- 「可更新」标签：`updateAvailable(pkg) || newer !== undefined`（L584 卡片、L808 详情页）。
- 「更新到 x」主按钮：`newer` 有值才出现（L776–781）。`newer` 来自宿主的版本检查，而版本检查**只对 `update === 'registry'` 的包运行**（L527–534）。
- 另一个描边样式的「更新」按钮（L770–775）由 `updateAvailable()`（L542–548）控制，需要 `installTarget`，只有官方按需 bundle 才有，第三方插件用不上。

### 2.3 「发现」页

`dsh-plugin-market/src/index.ts`：

- 「有新版本」状态（L505–510）：索引里的版本号用 `semver.gt` 比已安装版本新，就标 `update-available`。**不管是怎么装的。**
- 「更新」按钮（`dsh-client-ui-plugin-market/src/client/DiscoverSection.tsx` L83–113）需要某个版本的 `version.update === true`。它在 L481–485 计算：已安装的插件必须是 `update === 'git'`，而且索引里的这个版本固定在**同一仓库**的某个 commit 上，版本号更新。

所以 npm 来源的市场条目，在发现页**永远**只有「有新版本」文字，更新要去「已安装」页做。

## 3. 案例：dsh-llm-acp 0.2.1 为什么只有提示没有按钮

- 本机是开发环境，profile 里记录的是 `"dsh-llm-acp": "link:/Users/betty/dsh-llm-acp"`，宿主不给 `update` 字段，所以没有版本检查，也没有「更新到 x」。
- 发现页的条目来源是 npm（`dsh-llm-acp@0.2.1`），只会显示「有新版本」。
- 截图里 dsh-connect-workbuddy 有「更新到 5.25.2」，是因为它是用 npm 包名装的（`update: 'registry'`）。
- 普通用户只要是从市场或 `dsh plugin add dsh-llm-acp` 装的，就会在「已安装 → 详情页」看到「更新到 0.2.1」，但会受第 5 节的几种延迟影响。

## 4. dsh-connect-workbuddy 的做法（可直接照抄）

1. **只用 npm 发布，用自己的包名，严格遵守 semver。** 截至 2026-11-20 已发 156 个版本，`latest` 是 5.25.2。`prepack` 里先构建再做检查，保证包里的入口文件一定存在。
2. **安装说明只给 registry 规格**：`dsh plugin --profile desktop add dsh-connect-workbuddy`。用户这样装好后，自动就有「更新到 x」按钮。
3. **README 单独写一节「更新」**：
   - 手动更新只给一条命令，并且写**精确版本号**：`dsh plugin --profile desktop add dsh-connect-workbuddy@<版本>`。
   - 给出确认方法（它用 `dsh plugin … exec dsh-connect-workbuddy doctor`，输出第一行就是版本号）。
   - 提醒更新后重启或重载 DSH（bundle 的宿主部分在启动时加载）。
4. **提供一段「让 AI 更新」的提示词**：先 `npm view <包> version` 查最新版，再用精确版本号安装；如果遇到 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，不要改用浮动范围硬装；装完核对版本，最后提醒重启。
5. **置顶说明文档** `docs/PINNED-UPGRADE-LAG.md`，专门讲「点了更新却没升上去」的几个原因（见第 5 节），并强调以 `npm view` 和 GitHub Release 为准，不看市场上显示的版本号。
6. **单独说明开发者的 `link:` 安装**：不要对它执行 `add <包名>`（会把 `link:` 改写成 registry 规格）；更新方式就是 `git pull`，有构建产物的项目再 `build` 一次，然后重启。`link:` 不会跑 `prepare`，没构建的话入口文件不存在，DSH 会拒绝加载。
7. 仓库里**没有自建的 market-index**，靠社区市场的索引收录。

## 5. 更新「不及时」的常见原因

| 环节 | 现象 | 应对 |
|---|---|---|
| npm registry 处理 | `npm publish` 已返回成功，但 registry 上还是 404 或 `latest` 没变。dsh-llm-acp 0.2.1 实测等了约 4 分钟才可见 | 轮询 registry，确认新版本可见后再改索引、发通知 |
| 市场索引快照 | 社区索引是定期构建的快照，按包各自收录，可能落后好几个版本（workbuddy 实测过） | 以 `npm view` 为准；自建索引的话发版后及时更新 |
| DSH 自己的版本检查 | 结果有缓存；据 workbuddy 文档，桌面版会把 24 小时内发布的版本标成「新版等待中」（这一条未在源码里核实） | 等一等，或者直接用命令装精确版本号 |
| pnpm `minimumReleaseAge` | 浮动范围被**悄悄**解析回旧版（看起来装成功了，版本却没变）；写精确版本号则直接报 `ERR_PNPM_NO_MATURE_MATCHING_VERSION` | 写精确版本号；要马上装就在 profile 的 `pnpm-workspace.yaml` 里加 `minimumReleaseAgeExclude` |

## 6. 新项目照做清单

### 6.1 一次性准备

- `package.json`：`name` 用最终包名（以后不要改名或改成别名安装），`version` 用 semver，配好 `files`、`repository`、`dsh.bundle`。
- 有构建产物的项目：在 `prepack` 里构建，并检查 `main`/`exports` 指向的文件确实存在。
- npm 账号开启两步验证，或者准备一个开了「Bypass 2FA」的细粒度 token（只在发布时临时使用，不要写进仓库）。
- README 写好「安装」和「更新」两节（模板见 6.3）。

### 6.2 每次发版

1. 改版本号：`package.json`；用自建索引的话还有 `docs/market-index.json` 里的 `version`；README 里写死的版本号也要改。
2. 跑测试。
3. `npm publish --access public`。
4. 轮询 registry，直到新版本可见：
   ```sh
   curl -s "https://registry.npmjs.org/<包名>?t=$(date +%s)" \
     | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j["dist-tags"].latest,(j.time||{})["<版本>"])})'
   ```
5. 自建索引：把 `publishTimestamp` 改成 registry 返回的实际发布时间（秒）。
6. 提交（如 `chore: release x.y.z`）并推送。索引是通过 raw URL 读 `main` 分支的，不推送用户就看不到。
7. 本机是 `link:` 开发安装的话，到插件管理里把插件关掉再打开，或者重启 DSH。
8. 发布说明里提醒用户：**更新后要完全退出 DSH（⌘Q）再打开**。只关窗口不算，旧进程还在。

### 6.3 README「更新」一节模板

````markdown
## 更新

从插件市场或 `dsh plugin add <包名>` 安装的：打开 **设置 → 插件 → 已安装 → <插件名>**，点右上角「更新到 x.y.z」。
「发现」页只显示「有新版本」，不提供按钮，这是 DSH 的设计。

手动更新（写精确版本号，不要用 `^` 或 `latest`）：

```sh
npm view <包名> version
dsh plugin --profile desktop add <包名>@<上一步的版本>
```

更新后重启或重载 DSH。刚发布的版本可能还在等待期（pnpm `minimumReleaseAge` / DSH「新版等待中」），稍等或按上面的命令安装。

本地 `link:` 开发安装：`git pull`（需要的话再构建一次），然后重载插件。不要对它执行 `add <包名>`。
````

### 6.4 自建市场索引的注意点

- 安装来源写 npm 包规格（如 `<包名>@x.y.z`）：用户装好后就是 `update: 'registry'`，更新按钮在「已安装」页。
- 如果希望「发现」页也有更新按钮，安装来源要改成**固定完整 commit 的 Git 规格**，而且每个版本都固定在同一个仓库目录。索引字段的具体写法以 DSH 的 `parseMarketIndex` 为准，本文没有验证。
- 索引里的 `version` 只用来判断「有新版本」标记，不会让本来没有按钮的安装方式出现按钮。

## 7. 排查：用户说「有提示但没按钮」

1. 先看用户 profile 的 `package.json` 里这个插件记录的是什么值（如 `~/.dsh/profiles/desktop/package.json`）：
   - `link:` / `file:` → 本地安装，本来就没有按钮，用 `git pull` 更新或改用 npm 重装；
   - 精确版本号或范围 → 应该有按钮，看下一步；
   - `npm:` 别名或改过名 → 没有按钮，按包名重新安装。
2. 是不是在「发现」页找？npm 来源在发现页本来就没有按钮，要去「已安装」页。
3. 「已安装」页也没有：版本可能刚发布，还在等待期，或者版本检查还没刷新。可以等一会，或者用命令装精确版本号。
4. 装完版本号没变：多半是浮动范围被等待期压回了旧版，改用精确版本号。
5. **文件已经是新版本，新功能却不出现**：bundle 的服务端（宿主）部分是 DSH 启动时加载的，更新插件只换了磁盘上的文件，正在运行的服务端还是旧代码。前端是新的、接口还是旧的，新字段拿不到，界面上就像「没更新」。处理：⌘Q 完全退出 DSH 再打开（或在插件页把开关关掉再打开），然后在页面上 ⌘⇧R 强制刷新。
   - 用 `node -p "require('~/.dsh/profiles/<profile>/node_modules/<包名>/package.json').version"` 和 `grep` 新代码里的关键字，确认磁盘上的文件确实是新版本。
   - 实例：dsh-llm-acp 0.2.2 的「今日摘要」依赖服务端返回的 `today` 字段，另一台机器没完全重启时就不显示。
6. **新功能在「空数据」时太不显眼**：比如当天没有调用，只显示一行浅色小字，用户会以为没更新上。新加的界面元素在没有数据时也要保持同样的位置和样式（数值用「—」），并给出说明（如「最近调用 x 天前」）。dsh-llm-acp 0.2.3 按这个思路改过。
