# 官方赛事要求与 AI Works Skill 核验（2026-09-12）

> 本文仅记录当前可访问的官方公开页面与随官方 Hackathon 页面提供的部署 Skill。报名/开发状态以最新官方通知为准。

## 1. 官方赛事文章（证据）

当前公开 Hackathon 页面：<https://www.zhihu.com/hackathon>；页面导航可见“参赛队伍”“活动介绍”“申请 API 密钥与接口文档”“获奖公示”。第二期活动页为 <https://www.zhihu.com/hackathon?activity_code=zhihu_hackathon_2026_p2>，公开状态曾显示“组队已截止，当前无法创建或修改队伍”，提交权限仍需登录后核验。

来源：<https://zhuanlan.zhihu.com/p/2072692085925177157>

页面明确写出：

- 面向在校学生及毕业 3 年内职场新人；支持单人或 2–5 人组队，跨校/跨专业合作；开发与提交全程线上完成。
- 三条赛道：
  - **灵魂匹配局｜社区连接与兴趣社交**：从兴趣、观点和内容行为出发，设计同好发现、讨论参与、关系建立；鼓励内容驱动的兴趣匹配、表达助手、人与 Agent / Agent 与 Agent 的社区互动。
  - 知识炼金场｜学习工具与知识生产。
  - 跨次元游乐场｜AI 游戏与互动叙事。
- 官方资源：开放知乎官方 API，比赛期间提供 Token 支持；优秀项目有机会获得站内曝光、产研对接和导师辅导。
- 文章公开时间线：8 月 15 日—9 月 13 日报名组队；9 月 13 日 10:00—9 月 15 日 10:00 开发冲刺；9 月 15 日—17 日评审；9 月 19 日 13:00 决赛路演。**提交前需以最新官方公告复核**，不能只依赖旧帖。
- 文章未公开完整评审权重，项目材料不得自行写死比例。

## 2. 官方赛事圈子置顶（证据）

来源：<https://www.zhihu.com/pin/2030636306749809103>，圈子：<https://www.zhihu.com/ring/host/2029619126742656657>

置顶说明该圈子用于发布：活动通知、时间节点、赛道解读、参赛指南、API 文档、技术支持资料、嘉宾/路演信息和项目动态。置顶自身的“报名截止 5 月 8 日、5 月 12 日开赛、5 月 16 日路演”明显属于早期公告，不能当作当前 2026-09 时间线。

## 3. 官方提供的 AI Works 部署 Skill

当前页面内嵌的 Skill 指令、活动代码、API 入口可能随期次变化；不要仅依赖旧版本 helper 或旧 Access Secret 文档。提交前应以官方当前页面显示的下载地址和 API quickstart 为准。

官方 Hackathon 页面：<https://www.zhihu.com/hackathon> 页面内可发现 Skill ZIP：

`https://zhstatic.zhihu.com/skill/application/6adb-260831/zhihu-ai-works-deploy-helper_v1.1.2.zip`

本地核验版本：`zhihu-ai-works-deploy-helper`，manifest/README 标注 1.1.2 系列；Skill 适用于为知乎 AI Works / CloudBase 准备源码交付包，不等于已经部署云资源。

### Skill 的关键硬性要求

1. **先探测，后生成**：不得把本地构建产物当后端交付；使用 `inspect_node_project.py` 生成 `deploy-plan.json`，再用 `validate_deploy_output.py` 校验。
2. **纯静态分支**：只生成 `frontend.deploy.json`；禁止生成后端 manifest、bootstrap 或 cloudbaserc。争鸣当前是原生静态站，优先走此分支。
3. **Node/SSR 分支**：源码需监听 `0.0.0.0`，使用 `process.env.PORT`（fallback 9000），生成根 `scf_bootstrap` 和 `cloudbaserc.json`；后端入口、生产依赖、构建输出必须可确定。
4. **iframe 嵌入门禁**：AI Works 项目必须可被 iframe 内嵌。若存在 `X-Frame-Options: DENY/SAMEORIGIN`、CSP `frame-ancestors 'none'`/`'self'` 或 JS 顶层防嵌入，Skill 以 `E_IFRAME_EMBEDDING_FORBIDDEN` 阻断；不得在未得到明确授权前移除安全限制后打包。
5. **环境变量边界**：Node/SSR 运行时仅允许 Skill 明确注入的端口/主机变量；其他 `process.env` 使用会阻断，不能把密钥静默写入源码或 ZIP。
6. **包管理器与构建**：交付固定使用 npm；没有 package-lock 时先尝试 `npm install`；构建型项目必须确定输出目录，不能猜测。Next/Nuxt/SvelteKit 等有专门 resolver 契约。
7. **远端构建**：CustomSteps 顺序固定为安装依赖 → 构建并验证产物 →（overlay 时）准备运行时 package → `npm install --omit=dev --ignore-scripts` → 验证 → 安装 CloudBase CLI → 使用环境变量部署 HTTP 云函数。Skill 只准备输入，不创建/修改/部署 CloudBase 资源。
8. **归档排除**：ZIP 排除 `.git`、`node_modules`、构建目录、`.env*`、`.npmrc`、凭证/私钥、符号链接和非普通文件；需通过 CRC/最终校验。

### 对争鸣项目的直接结论

- `web/` 是零依赖纯静态前端，无需 Node 后端即可演示，适合 Skill 的 **static-files** 分支。
- 公网 GitHub Pages Demo 与 AI Works/CloudBase 交付是两条路径：前者继续用于比赛演示，后者可按 Skill 生成源码 ZIP，不能在材料中写成“已经部署 AI Works”。
- 若日后启用 `server/index.mjs`，需单独按 Node 分支探测；必须先解决 `PORT`/`0.0.0.0`、iframe 响应头和生产依赖等门禁。
- 文案应明确：当前默认是离线快照 + 本地规则裁判；知乎 API/Token 为可选接入，是否开放及额度以官方账户与最新公告为准。

## 4. 提交材料建议

- 体验链接：GitHub Pages Demo。
- 仓库链接：公开 GitHub 仓库。
- 计划书/产品说明：明确赛道、真实问题、连接闭环、离线快照边界、作者与回答 ID 溯源。
- 演示视频：3 分钟内优先展示“问题分歧地图 → 选立场 → 写回应 → 四维体检 → 回到原回答/邀请朋友复核”。
- 如提交系统要求 AI Works 作品链接，再提供 Skill 生成的前端交付描述符/ZIP；不要将 ZIP 误写为已完成云部署。

*更新规则：任何新官方公告、参赛手册或 API 文档出现后，应在提交前替换本文对应的“待复核”状态。*
