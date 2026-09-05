# PaperOrchestra 用户指南

PaperOrchestra 用于把已有研究材料组织成论文：理解材料、规划内容、检索文献、制作图表、撰写正文、编译 PDF，并根据审阅结果修订。

你不需要提前准备好 Bib、论文图片、排版表格或大纲。主要输入是一个有足够研究信息的目录，以及可选的写作要求。系统不会凭空补做研究实验，也不会把缺失的结果编造成事实。

本文介绍普通用户的使用方法。开发者需要用 Docker 模拟用户、验证源码改动时，请阅读 [DEV.md](DEV.md)。Docker 和 `npm test` 不是普通用户写论文的必经步骤。

## 1. 安装与环境检查

### 安装 PaperOrchestra

先准备 Node.js 20 或更新版本、npm 和 Git，然后运行仓库提供的安装脚本：

```bash
curl -fsSL https://raw.githubusercontent.com/a-green-hand-jack/paper-orchestra/main/scripts/install.sh | bash
```

这是执行远程安装脚本的方式，使用前应确认来源可信。已经克隆仓库的用户，也可以在仓库根目录运行：

```bash
bash scripts/install.sh
```

远程安装会构建并安装打包后的 CLI；从本地仓库安装会建立全局链接，因此不要随后删除该仓库。安装脚本不会替你配置模型账户或完整安装 TeX 环境。

确认命令可用：

```bash
paper-orchestra --version
paper-orchestra doctor
```

如果找不到命令，检查 npm 的全局可执行文件目录是否在 `PATH` 中。

### 运行需要什么

| 用途 | 需要准备的环境 |
|---|---|
| 写作与审阅 | 已安装并配置可用模型的 OpenCode；完整流程的图片/PDF 审阅需要图像输入能力 |
| 文献检索 | 已安装并登录的 `bohr` CLI，以及付费检索授权 |
| LaTeX 与 PDF | TeX 发行版、`pdflatex`、`bibtex`，以及 Poppler 的 `pdftotext`、`pdftoppm`、`pdfinfo` |
| 数值图 | `python3`，并能导入 NumPy、Matplotlib |
| GPT 概念图 | 支持并启用 `image_generation` 的 Codex CLI，使用 ChatGPT OAuth 登录；或已配置的外部图像适配器 |
| 从 Hugging Face 获取材料 | 可选的 `hf` CLI；材料已经在本地时不需要它 |

OpenCode 的常规登录入口是 `opencode auth login`；使用自定义 provider 时，按该 provider 的方式配置。不要把 API 密钥、令牌或认证文件放进研究材料目录、brief 或 Git 仓库。

若使用自定义模型，可以明确检查该模型的配置：

```bash
paper-orchestra doctor --model openai/gpt-5.6-sol
```

这里的模型名称只是示例，必须换成你实际配置的模型。此检查确认模型配置可见，不代表已经完成一次真实模型请求；认证会在实际调用时得到验证。

`doctor` 的 `FAIL` 表示缺少硬性要求；`warn` 表示某项能力未就绪。如果本次论文需要该能力，正式运行仍可能因此停止。

## 2. 准备研究材料

一个材料目录可以是代码仓库，也可以是笔记、实验日志和结果文件的集合。例如：

```text
my-research/
├── README.md             # 研究问题、方法、已有结论
├── src/                  # 实现代码
├── configs/              # 实验配置
├── logs/                 # 实验运行日志
├── results/              # CSV、JSON 等结果
├── figures/              # 可选：已有图片
└── references.bib        # 可选：已有参考文献
```

这些名称不是强制规范。对初次使用，最重要的是材料中能找到研究问题、方法、实验设置和支撑结论的结果。

- 可以只给代码、原始结果和说明，不需要先写一份论文草稿。
- 可以保留已有实验汇总；它们不等于已经制作好的论文表格。
- 想复用已有图片时，建议集中放在 `figures/` 中，避免与论文截图混在一起。
- 系统对文本、代码、CSV/JSON、Notebook、SQLite 和部分 NumPy 数据提供读取或受限提取能力；不能假定所有二进制格式都能直接理解。
- 已有论文成稿不应作为这次独立写作的输入。最好在交付材料时就把成稿 PDF、成稿 TeX、提取的成稿正文与原始研究分开。
- PDF 会经过分类和受限处理，不是所有 PDF 都会完整提取正文。无法明确判断用途或无法读取的文档可能被隔离或登记为不可读。
- 原始材料导入有边界：单文件上限 64 MiB，最多 5,000 个文件，总量上限 256 MiB；具体提取和分析操作还有各自的限制。注意运行时的跳过、不可读和材料不足提示。

不要把整个主目录、模型缓存、虚拟环境或密钥目录当作研究材料。文件被复制进工作区，也不代表其内容已经被完整理解。

### 可选：写作要求 brief

你可以额外提供 `brief.md`，说明投稿目标、篇幅、语言、重点和必须遵守的边界，不必在里面替系统写好论文。

```markdown
# 写作要求

- 使用英文，准备匿名审阅稿。
- 目标为 8 页左右，突出方法和主要实验结果。
- 解释已有消融实验，并准确讨论局限。
- 从结果文件生成必要的图表，自主检索相关工作。
- 不开展新实验，不把没有记录的比较写成实验结论。
```

没有 brief 也可以启动。明确的命令行选项优先于 brief，brief 优先于系统默认偏好；例如 `--template` 会覆盖自动选择。模板和预算等配置会在准备工作区时锁定。

## 3. 最快开始写作

下面的命令从一个包含 `my-research/` 的父目录执行。输出目录 `paper-run/` 应当是一个新的工作区，和原始材料分开。

```bash
paper-orchestra write ./my-research \
  --headless \
  --allow-lkm-spend \
  -o ./paper-run
```

有写作要求时：

```bash
paper-orchestra write ./my-research \
  --brief ./brief.md \
  --headless \
  --allow-lkm-spend \
  -o ./paper-run
```

这条命令会建立工作区，然后执行：

```text
材料理解 → 论文大纲 → 文献整理 → 图表 → 正文 → 审阅与修订
```

默认行为如下：

| 项目 | 默认行为 |
|---|---|
| 写作模式 | `autonomous`，不要求逐阶段人工批准 |
| 网络 | `online`，允许控制器调用需要的在线服务 |
| 模型 | 使用 OpenCode 的默认模型 |
| 模板 | 自动发现合适的作者模板，或按材料与要求选择内置模板 |
| 图表 | 自动生成计划中的图表，也可复用合适的已有图 |
| Bib | 已有 Bib 作为种子，允许检索补充；没有 Bib 时自主检索 |
| 引用目标 | 根据论文需要推断，除非显式指定 |
| 输出位置 | 不指定 `-o` 时，在当前目录创建 `po-run-<时间戳>` |

`--headless` 表示不打开交互界面，不表示自动后台执行。前台命令会一直占用当前终端，直到结束或暂停。

## 4. 长任务在后台运行

写作、文献服务和图片生成可能持续较长时间。Linux/macOS 用户可以使用 `tmux`，让任务留在后台，不占用日常交互终端：

```bash
tmux new-session -d -s paper-write \
  'paper-orchestra write ./my-research --brief ./brief.md --headless --allow-lkm-spend -o ./paper-run > ./paper-run.log 2>&1'
```

该命令从启动时的当前目录解析相对路径。没有 brief 时去掉 `--brief ./brief.md`。日志放在工作区外，即使写作很早失败也能保留诊断信息。

在另一个终端快速查看状态：

```bash
paper-orchestra status ./paper-run
less ./paper-run.log
```

需要进入仍在运行的终端时：

```bash
tmux attach -t paper-write
```

退出附着界面但保留任务：依次按 `Ctrl-b`、`d`。会话已经结束时，继续通过日志和工作区状态查看结果即可。也可以使用操作系统的其他后台任务管理方式；不要只依赖容易断开的远程终端。

### 交互界面与人工协作

希望使用 OpenCode 原生终端界面时，去掉 `--headless`：

```bash
paper-orchestra write ./my-research --brief ./brief.md --allow-lkm-spend -o ./paper-run
```

希望在关键节点人工批准时，使用 `--mode collaborative`：

```bash
paper-orchestra write ./my-research \
  --mode collaborative --headless --allow-lkm-spend -o ./paper-run
```

协作模式在材料理解、大纲、文献、正文和修订后设置五个关卡。headless 模式到达关卡会保存状态并退出，随后可以执行：

```bash
paper-orchestra approve ./paper-run
paper-orchestra resume ./paper-run --headless --allow-lkm-spend
```

不要把 `approve` 当作绕过失败检查的命令；它只用于释放等待人工批准的关卡。

## 5. 查看进度和恢复运行

```bash
paper-orchestra status ./paper-run
paper-orchestra history ./paper-run
```

| 状态 | 含义与处理方式 |
|---|---|
| `prepared` | 工作区已准备，但尚未开始或继续执行阶段 |
| `running` | 正在执行；不要再对同一个工作区启动第二个控制器 |
| `gate_waiting` | 协作模式等待批准；先 `approve`，再按需要 `resume` |
| `failed` | 当前尝试失败；先查看错误和日志，解决后再恢复 |
| `interrupted` | 运行被中断，已保存的状态与产物可以用于恢复 |
| `completed` | 当前锁定计划已完成；短计划完成不等于完整论文完成 |

认证、服务、编译或中断问题解决后，用原工作区恢复，不要重新 `write` 到同一路径：

```bash
paper-orchestra resume ./paper-run --headless --allow-lkm-spend
```

已有成功产物会按当前检查与缓存规则复用。恢复不会清空累计预算，也不能通过 `resume` 更换模型、模板、材料或其他已锁定配置。需要改变输入或锁定选项时，创建新的输出工作区，保留旧结果作为对照。

不要手工改写 `.po-run/` 状态、来源哈希、控制器证据或审阅的 `ready` 字段来制造完成状态。

## 6. 获取论文，判断是否完成

完整流程成功后，优先查看工作区的 `submission/`：

```text
paper-run/
├── submission/
│   ├── final.pdf          # 交付 PDF
│   ├── main.tex           # 可编辑的论文入口
│   ├── references.bib
│   ├── figures/
│   ├── tables/            # 有生成表格时
│   └── README.md          # 重编译说明，另附必要样式/依赖文件
├── .brain/
│   ├── manuscript/        # 草稿、修订稿、当前编译 PDF、审阅记录
│   └── raw/               # 材料理解、大纲、文献与计算记录
└── .po-run/               # 状态、预算、操作和审阅历史等
```

运行中的预览通常位于：

```text
paper-run/.brain/manuscript/final_paper.pdf
```

**文件名叫 `final_paper.pdf`，不代表已经通过验收。** 它可能是草稿编译结果，或落后于正在修改的 `final_paper.tex`。不要把文件存在当作写作成功。

在合适的阶段或运行结束后，可以执行检查：

```bash
paper-orchestra validate ./paper-run
```

`validate` 不调用模型，也不会替你执行一轮修订或重新编译；它检查当前产物、构建记录和审阅状态。整条计划尚未执行完时，检查会报告缺少后续产物，这不一定表示运行卡住。

给 `write` 或 `resume` 加上 `--json`，其最终结果对象会包含：

| 字段 | 应如何理解 |
|---|---|
| `run_state` | 当前运行状态 |
| `plan_completed` | 锁定计划是否完成，包括短计划 |
| `submission_ready` | 完整修订及当前论文的就绪检查是否通过 |
| `artifacts` | 当前已有产物的路径，未生成的产物可能为 `null` |
| `budget` | 累计计量和预算信息；未报告的费用不代表免费 |

`--json` 的 `write`/`resume` 输出是逐行 JSON 事件加最终结果，不是一个单独的大 JSON 文档。`ok: true` 也可能只是准备完成或等待审批，不能单看它判断论文完成。

PaperOrchestra 会自主审阅与修订，但当前版本仍在迭代。系统通过检查不等于保证录用，也不是对所有科学判断的证明。投稿前应确认目标场合要求、署名和必要声明；系统不会替你编造这些信息。没有作者信息时，按匿名审阅稿处理。

## 7. 常用选项与费用

### 模型和模板

```bash
paper-orchestra templates list
paper-orchestra write ./my-research --template iclr2026 --headless --allow-lkm-spend -o ./paper-run
```

也可以给出本地模板目录：`--template ./my-template`。应提供作者模板或样式，而不是另一篇完整论文。

模型引用格式为 `provider/model[:variant]`，例如 `openai/gpt-5.6-sol`；provider、模型和 variant 必须确实可用。可以为个别阶段指定不同模型：

```bash
paper-orchestra write ./my-research \
  --model openai/gpt-5.6-sol \
  --stage-model refinement=openai/gpt-5.6-sol:high \
  --headless --allow-lkm-spend -o ./paper-run
```

### 文献和图表

| 选项 | 用途 |
|---|---|
| `--bibliography-mode seed` | 默认模式，使用已有 Bib 并允许检索补充 |
| `--bibliography-mode closed` | 只使用你提供的 Bib，跳过付费检索；没有可用 Bib 时不能使用 |
| `--research-cutoff 2026-09` | 限制纳入的文献发表时间；默认当前月份 |
| `--target-citations 10` | 显式指定引用目标；不指定时按论文需要推断 |
| `--no-plotting` | 不自动生成新图；并不关闭论文写作或自动表格处理 |
| `--network-policy offline` | 显式限制控制器的在线工作；不是 Docker 的物理网络隔离，也不提供本地模型 |

概念图可以通过 GPT 文生图生成；数值图应使用真实实验数据绘制。未提供图片时，不要加 `--no-plotting`，否则系统不能替你制作所需的新图。

不要把 `--network-policy offline` 当成保密隔离开关：远程模型仍可能需要网络连接。需要禁止所有外部通信时，应另行配置系统或容器网络隔离，并确认所用模型和服务能在该环境运行。

### 预算和授权是两回事

`--allow-lkm-spend` 用于本次启动/恢复的付费文献检索授权。当前参考价格约为每次 0.05 元，默认最多 40 次检索，约对应 2 元的检索额度，不是整篇论文的总费用。

文本模型、审阅和图像服务另有各自的账户、额度或费用。提供 Bib、关闭检索或采用订阅账户，都不应被解释为整次运行一定免费。

| 参数 | 新运行默认值 | 含义 |
|---|---:|---|
| `--max-lkm-calls` | 40 | 文献检索调用上限 |
| `--max-total-tokens` | 8,000,000 | 全程累计计量，包含输入、输出、推理和缓存等字段 |
| `--max-total-cost` | 100 | 已知模型费用上限，单位 USD；不是包括未知费用与检索费用的总账单保证 |
| `--max-model-calls` | 80 | 控制器提示提交次数，不等于模型在一次会话内的所有 API 轮次 |
| `--max-image-calls` | 12 | 图像调用上限 |
| `--max-operation-calls` | 64 | 控制器操作调用上限 |
| `--max-run-minutes` | 120 | 累计活动分钟数，不含暂停时间 |

设置预算不会自动授权付费。使用前还应设置服务商侧的支出限制，并留意计量可能存在延迟及未报告费用。自动模板选择发生在工作区建立之前的模型调用，不在该工作区的累计预算账本内。

预算耗尽后，原结果会保留；重复 `resume` 不会重置它。需要不同预算时，应以明确的新配置创建新工作区，不要修改旧状态文件。

### 只准备工作区或只写大纲

```bash
paper-orchestra write ./my-research --prepare-only -o ./paper-prepared
paper-orchestra write ./my-research --until outline --headless -o ./outline-run
```

`--prepare-only` 会创建和锁定工作区，自动选模板可能调用模型，不是零费用、无副作用的 dry run。之后可对该工作区 `resume`。

`--until outline` 会锁定一个到大纲为止的短计划，后续 `resume` 不会自动把它扩展成完整论文。完整写作需要建立完整计划的新工作区。

## 8. 常见问题

| 现象 | 处理方式 |
|---|---|
| 提示工作区已存在 | 新论文用新的 `-o`；继续已有任务用 `resume`，不要覆盖原目录 |
| 没有提供 Bib | 属于正常使用方式；配置 `bohr` 并授权检索即可 |
| 提供了 Bib，仍要求检索授权 | 默认是 seed 模式；确实只想使用已有文献时，在新运行中选择 closed 模式 |
| 文生图不可用 | 检查 Codex 的 ChatGPT 登录、image_generation 能力或外部适配器；不要把数字图换成没有数据依据的图片 |
| 程序很久没有终端输出 | 查看 `status` 和后台日志；一次模型调用中日志可能较少，不要立即重开同一工作区 |
| 有 PDF，但状态不是 completed | 这是预览或未通过审阅的产物；查看失败项或等待后台修订结束 |
| 有编译/审阅错误 | 系统会在预算内尝试修复；最终仍失败时查看错误、解决环境或材料问题，再恢复 |
| 导入时跳过关键材料 | 查看 `.brain/input-import-manifest.json` 和 `.brain/input-manifest.json`，补充可读的原始证据后用新目录重试 |
| 修改原始材料后，旧任务没有变化 | 工作区使用的是导入并锁定的副本；新材料应建立新运行 |

提交问题反馈时，提供 PaperOrchestra 版本、去掉敏感内容的命令、阶段状态、错误和必要的最小材料。不要上传认证文件、API 密钥或含敏感信息的完整日志。

更多命令以当前安装版本的帮助为准：

```bash
paper-orchestra --help
paper-orchestra write --help
paper-orchestra resume --help
paper-orchestra validate --help
```
