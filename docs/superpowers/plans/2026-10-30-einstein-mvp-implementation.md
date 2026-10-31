# EINSTEIN MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付固定三Agent、真实并发、可核验证据与Critic门槛的本地产品，一屏展示三个不同配对及各自完整运行记录。

**Architecture:** Node父进程控制全局admission、请求permit、持久化、SSE和发布；每Run独立子进程，内部一个Mozaik Runtime、新State与独立角色Context。全库本地检索后最多8人进入精查；两个分析Agent并发，Critic独立审查，最多一次定向补查。React/Vite展示真实事件、证据、决策变化和Proposal Showcase。

**Tech Stack:** 现有Node 24、pnpm 11.25、TypeScript、React/Vite、固定@mozaik-ai/core@4.2.0、Zod；Node内置HTTP/fetch/test/child_process/fs；不引入第二Agent框架、数据库、向量库、队列或云服务。

**Spec:** [设计v1.1](../specs/2026-10-30-einstein-mvp-design.md)、[接口契约v1](../specs/2026-10-30-interface-contracts.md)。具体测试材料见[召回方案](../../startup/retrieval-validation-design.md)、[Critic对抗矩阵](../../startup/critic-adversarial-design.md)、[Windows实测](../../startup/windows-process-verification.md)。

## Global Constraints

- 固定Proposer、Counter-evidence、Critic三个Agent；不把程序协调器计为第四Agent，不以串行/动画冒充并发。
- 每Run独立Runtime、State、Agent/context和子进程；同一Agent不重入活动task，补查用新Context。
- 数据固定`4fb99b3749adf0d10b5977089ff4c73f4f522240`；只读官方合成数据，ID主键，姓名不自动合并，原文不改写。
- 单Run精查不同研究者≤8；全库每召回通道top40、去重并集≤120。补查只在原8人内；池外线索记入diagnostics/refinementSuggestion，必要时insufficient，由新Run重新检索，禁止自动连开Run绕预算。
- Critic approve/revise/insufficient；最多一次定向补查。只允许当前输入/池/反证/草稿/Evidence快照的批准发布；排版不新增事实。
- 硬限制：每Run16次获准请求尝试、单HTTP40秒、Run180秒（admission开始）；全局1活跃Run、3等待、等待120秒；全局2个模型请求在途。次数失败/取消不回补。
- 无自动模型/网络重试，无静默模型切换；当前卡先用，到期由用户替换。Token/费用不作首版硬预算，缺usage字段unknown，不造0或金额。
- 本地优先、Node绑定127.0.0.1；前端不持密钥，真实.env忽略；worker不启动CLI/孙进程；公开部署/对外联系另行决定。
- Task1/2已验收；Task3来源/定位/Hash/结构关系CONDITIONAL PASS；Task4工程已接收，质量仍待验收/holdout封存。本轮仅Task5基础设施，完成报告后停下，Task6–10不提前开始。按模块测试/最小实现/实际验证/独立审查推进。
- 本机未安装header提到的两个完整执行子Skill，不声称已调用；后续按用户明确的逐模块验证流程使用原生工具与已安装工程Skills，不为形式擅自安装一套依赖。

## Review Focus

1. 已存在且hash正确的Evidence被换给其他Claim/研究者：Task2/3/7必须拒绝对象不绑定，语义无关另由真实Critic评测。
2. cancel/timeout发生在ready之前或完成/批准竞争时：Task5/7必须登记spawn即取得的身份、单一终态、清理确认，迟到结果无发布权。
3. Showcase三卡实际是同一配对不同challenge/版本：Task8/9/10按companyId+researcherId去重，剔除adversarial/fixture/无效批准。
4. 改写/转写查询使正例被8人截断丢失：Task4分别测全库覆盖、大并集capture和8人保留；未判样本不当无关，无标签不报semanticRecall。
5. Counter缺失、notes截断或材料自称approved：Task6/7先验收完整输入和可信角色，再测独立Critic的技术判断，不能仅凭泛泛否决通过。

## 目录和责任

以下均是待创建的产品文件；`preparation/`保留现有独立实验，不直接当生产实现。

```text
package.json / pnpm-lock.yaml / tsconfig.server.json / vite.config.ts
scripts/
  setup-data.mjs                  # 固定版本获取/核验，不覆盖已有数据
  test-offline.mjs                # 只枚举tests下*.test.mjs，不运行online评测
src/
  contracts/{domain,events,ipc,config}.ts
  contracts/canonical.ts         # 确定性产物序列化，不读取环境
  data/{snapshot,records}.ts
  evidence/{store,validate,hashing}.ts
  retrieval/{normalize,index,select,diagnostics}.ts
  model/gateway-runner.ts
  runtime/{worker-entry,task-context,orchestrator,observer,tools}.ts
  runtime/agents/{proposer,counter-evidence,critic}.ts
  publishing/gate.ts
  supervisor/{scheduler,process-host,permits}.ts
  storage/run-store.ts
  server/{main,routes,sse}.ts
  showcase/catalog.ts
  evaluation/{retrieval-report,critic-cases,run-critic-eval,export-showcase}.ts
web/
  index.html
  src/{main,App,api}.tsx
  src/components/{ChallengePicker,AgentTimeline,EvidenceInspector,DecisionEvolution,ProposalShowcase}.tsx
  src/styles.css
tests/
  fixtures/                      # 原始出处/攻击变更/预期标签，不放key
  unit/{contracts,evidence,retrieval,gate}.test.mjs
  integration/{process-host,scheduler,permits,runtime,api,showcase}.test.mjs
artifacts/{evaluations,showcase}/ # 仅明确脱敏、已校验的真实结果可提交
var/runs/<runId>/                # 本地输入、events.jsonl、artifacts/vN、outcome
.cache/retrieval/                # 索引版本/hash，忽略提交
reference/einstein-matchmaker-data/ # 已有固定原始数据，忽略嵌套仓库提交
```

`src/contracts`由前后端共享，其余Node模块不能被web导入。`web/src/api.tsx`只封装typed fetch/SSE；Evidence Inspector不接受任意文件路径。完整DTO、函数签名、HTTP/SSE/IPC消息以接口契约v1为准。

## 分阶段执行任务

各任务开始前重读Spec及其生产者接口。测试步骤均为未来命令/期望，下面没有声称已经运行。产品`.test.mjs`导入`dist/server`；统一入口`pnpm test:offline -- <tests下文件或目录>`必须先成功执行build:server再运行显式枚举的测试，支持受限路径过滤，拒绝tests外路径和online评测。每次红/绿测试均重新编译，不能测旧dist。提交只包含该模块明确文件，不`git add .`带入本地密钥、嵌套reference仓库或未复核产物。

### Task 1：最小工程与固定环境（约0.5h）

**Files:** 创建根package/config、`scripts/setup-data.mjs`、`scripts/test-offline.mjs`、可编译的空`src/server/main.ts`及最小web/index入口；更新`.gitignore`；不创建业务模块或UI功能。

**Interfaces:** 产出`build:server`、`build:web`、`test:offline`、`dev:web`、`start`脚本；backend输出`dist/server/`，worker路径`dist/server/runtime/worker-entry.js`，web输出`dist/web/`。NodeNext ESM，源码相对模块使用可编译的`.js`导入后缀。

- [x] 核对Node/pnpm/core和固定数据；setup只在缺失时获取，已有脏/错误版本拒绝且不改写。
- [x] 精确固定8个直接/开发依赖及锁文件；Node24.19.0/pnpm11.25.0/core4.2.0，types/node24.19.2；Task1未用Zod直接API，留到Task2声明直依赖；年龄保护仅精确core例外。
- [x] 完成先编译/安全枚举、web先类型检查再打包、旧server输出清理和链接保护，不执行online评测。
- [x] 后端/web/冻结离线安装与33项工具测试通过、独立审查通过；功能提交bedb9d6，详见[Task1验收](../../implementation/task-1-foundation.md)。

### Task 2：共享契约、hash与状态规则（约1h）

**Files:** `src/contracts/{domain,events,ipc,config,canonical,primitives,state}.ts`、`src/evidence/hashing.ts`；`tests/unit/{contracts,canonical,bundle,events-ipc,hash-projections}.test.mjs`；浏览器复用探针`tests/tooling/contracts-browser.test.mjs`、`tests/fixtures/browser-contracts.ts`、`tsconfig.contracts.json`。

**Interfaces:** 提供RunInput/RunStatus、CandidatePool、Evidence、Claim、ProposalDraft、CounterReport、CriticReview、StoredEvent、IPC discriminated schemas及limits；`canonicalizeArtifact`在纯contracts模块，`hashArtifact`在Node evidence/hashing模块，按契约v1。

- [x] 已写严格ID/IPC/role/自封approve/unknown usage/Unicode/终态/序列化负例；事件角色矩阵、Counter整池覆盖和终态历史组合另经审查加红绿回归。
- [x] Task2完成sourceFileSha256必填/格式及原始字节helper的BOM/换行差异测试；Task3仍须实施真实源文件读取和不匹配拒绝，不能由本轮schema测试冒充。
- [x] contracts/canonical/events-ipc初次因缺模块各退出1；后续针对组合漏洞的真实红绿记录保存在Task2验收报告。
- [x] 严格schema、精确Hash投影/类型导出/状态规则完成。Review绑定input/pool/counter/draft/evidence；默认1Run，按已批准设计保留父进程显式2Run隔离配置。
- [x] 最终全量95过0败（Task1回归33+Task2新增62）；无Node ambient类型检查、Vite全共享导出打包和无Node全局VM执行通过；独立复审无剩余代码阻塞，明确清单提交。

### Task 3：只读数据与Evidence/Claim来源绑定（约1.5h）

**Files:** `src/data/{snapshot,records}.ts`、`src/evidence/{store,validate}.ts`；`tests/unit/{snapshot,evidence,evidence-casebook}.test.mjs`、`tests/fixtures/evidence-cases.{json,mjs}`（原案例包逐字节副本与只读legacy adapter）。

**Interfaces:** 消费Task2契约；提供`loadSnapshot`、`resolveField`、`resolveEvidence`、`createEvidenceSnapshot`、`verifyEvidence`、`validateClaimSources(draft,snapshot,evidenceList)`（第三参数及非字符串编码/CSV分流由用户明确批准）。完整原记录和允许字段按ID只读，模型不能提供任意路径。冻结原始snapshot与当前Evidence副本，分类来源/定位/关系/不足/语义待审；测试copy明确标记不冒充official。

Task3必验：sourceFileSha256缺失、格式错误、与整个源文件原始字节Hash不匹配都拒绝；BOM/换行参与原字节Hash，不能用record Hash替代。

- [x] 13案/75段原样保留为tracked fixture；73段生产核验，2CSV只历史回归。补ID/字段/关系/Hash错配、null/同名/profile-only、真实项目专利页面、Unicode/完整notes、不可变与路径/Git替代攻击回归。
- [x] snapshot/evidence先缺模块红再最小实现；独立审查负例35组31过4败→35过；真实空摘要分类27组26过1败→27过。不读取模型或判断自然语言语义，不改原数据。
- [x] Node生产Hash与legacy Python安全整数canonical分别实现/标记；不将73个当前数据Hash恰好相同冒称两个规范通用等价。背景source_field仍需后续Critic，未实现排版/发布模块。
- [x] 初轮142过及失败记录保留；用户复核后的关系字段修复新增20项11过9败→20全过，全量162过、Web类型构建过，8源Hash不变。用户已确认CONDITIONAL PASS，允许Task4；仅来源/定位/Hash/结构关系，不代表语义/Critic/发布能力。

### Task 4：全库召回、解释和低质量门槛（约2.5h）

**Files:** `src/retrieval/{normalize,config,concepts,index,select,diagnostics}.ts`、`src/evaluation/{metrics,retrieval-report}.ts`、检索/归一化/指标/报告入口测试及查询/标签manifest；用户授权补充snapshot只读listRecords及测试。

**Interfaces:** 消费snapshot/SourceRef，生产CandidatePool/RecallDiagnostics；初始全库→每路40→并集120→≤8。池版本进入后续所有产物，单Run不换入池外人员。

- [x] 排名前冻结6dev/3holdout原始查询和按企业/改写组隔离分组；已公开锚点仅dev。人工标签0，相关性/来源充分性分开且unjudged/not_assessed。保留每题至少8个人工已判要求，不能以AI种子替代。
- [x] 测试先红后绿：全库/身份、NFC/转写/digraph/非词形、领域边界、限制原文、稳定排序/去重/40/120/8、空池不填充、原始Evidence定位/Hash；完整197过，Web类型/构建过。
- [x] 实现L0/L1/L2，全库1047人且成果只按明确researcher_id关联；保留原文、原查询/变换/全部限制、三路分数/命中/融合/截断。一次确定性扩展不增加8人或Critic轮次；低质量返回诊断，不在Task4驱动Run状态。
- [x] 仅dev完成L0/L0+L1/L0+L1+L2共18次对照，工程freeze先于本次排名；0人工标签的capture/precision/retention为NA，保留分母和未判比例及全部真实产物/失败。本轮用户明确holdout封存，3题unopened，无排名/候选；没有校准或批准质量门槛。
- [ ] 匹配质量验收待真实人工每题至少8个已判、质量规则共同确定及另行授权holdout。已判正例无未解释丢失目前不能确认；没有分母不得声称质量通过。
- [x] 工程独立审查后无剩余阻塞；根目录/接口/评测/复现文档、完整输出和报告保留。历史CRLF收口仅提方案，未修改原始数据/旧manifest/生产Hash。Task4不作整体PASS，完成报告后停下不开始Task5。

### Task 5：Windows进程宿主、admission与全局permit（约2.5h）

**Files:** `src/supervisor/{process-host,scheduler,permits,deadline}.ts`、`src/storage/run-store.ts`；`tests/integration/{process-host,scheduler,permits,run-store}.test.mjs`、两个offline fixture与只读进程审计脚本。deadline是本阶段剩余时长/稳定取消的内部工具，不引入依赖。

**Interfaces:** Task2 IPC；`submit/cancel/acquire/release/appendEvent/commitOutcome`见契约。父单一写入口、从spawn起记录身份，admission起180s，队列120s，全局1Run/3等待/2请求、每Run16个permit。

- [x] Windows实际fixture覆盖ready前/后失败、never-ready、超时、取消/完成竞争、异常隔离、中文空格、默认1+3和可信2个真实worker。State/Context为普通offline_fixture对象，未当Mozaik业务验证。失败先保存再修。
- [x] 同一原生handle出生时间核验、唯一Run标记、逐层后代出生关系、close和后检；不盲发taskkill。已登记OS conhost也核验清理；未知孤儿/硬OS故障没有JobObject保证。
- [x] 全局2、每Run16/17拒、并行/idempotence/跨Run/释放/退出回收，排队取消及创建/admission写盘取消零spawn零permit；清理未确认hold。单调期限不因UTC回拨延长，停止不等挂起写盘，但写盘恢复后再核期限/停止/hold才可发授权或fork。
- [x] 父串行磁盘确认、原子terminal bundle；坏行、截断、失败写入、重启unfinished/cleanup不明不续跑、不approved；后台写失败经清理后仍传播给close，不把旧事实消息误丢。
- [x] 最终276/276、Web类型/构建通过；只读审计229归档原身份已不在、fixture0，活进程正控制证明审计路径有效，所有实际失败/恢复/审计旧结果保留。工程结果待用户验收，未开放Task6。

### Task 6：真实Mozaik runner、三角色和应用协调（约2.5h）

**Files:** `src/model/gateway-runner.ts`、`src/runtime/{worker-entry,task-context,orchestrator,observer,tools}.ts`、三个`runtime/agents/*.ts`；`tests/integration/runtime.test.mjs`。

**Interfaces:** 生产`createGatewayRunner(...): InferenceRunner`与`executeRun(...): Promise<RunOutcome>`应用wrapper。Task5控制permit，Task3只读工具，Task4固定池；不将这些应用函数说成Mozaik导出。

- [x] 先写离线框架测试：真实core4.2创建3 Agent，新State/Context，Proposer/Counter均进runner再完成，Critic必须等两产物，错误producer/早到review/重入/超过一次补查均拒绝。fixture明确标offline，不能证明模型判断。
- [x] 按已测API实现defineRuntime().initializeRuntime/join、SituationSpecification、原生runLoop与应用Observer；raw runLoop返回void，应用deferred由原生事件/schema收口，下一task新Context且busy guard有效；native producer/Context与错误fence/worker退出边界已验证，不伪造SDK导出。
- [x] 只暴露`read_company_challenge`、`read_candidate_bundle`、`read_evidence_record`等语义不重叠的只读工具，参数本地验证，不接受任意路径、池外researcher或正文控制指令。使用真实Tool.invoke和function_call事件，最多一个tool_call，否则拒绝。
- [x] gateway runner先申请parent permit再fetch，正常TLS/固定已配置主机、不跟带凭据重定向、40s abort，无自动重试；developer→system、function/tool_call_id→原生Context准确映射。usage只作网关报告，不据此计准确费用；补1MiB reader及配置key反射拒绝。
- [x] 离线测试通过后，仅执行一次明确标为live的产品adapter两Agent工具探测，验收独立ID、原生工具事件、上下文回传及实际请求重叠；保存结果，失败定位原因，不用fixture顶替。本次4HTTP/5626.087ms交叠，工具nonce与Context Hash一致，父端诊断insufficient无发布。
- [x] 记录adapter边界、密钥无前端/日志暴露后按白名单本地提交；Critic质量仍待Task7，不能宣布此时已有可靠提案。完整399/399及Web通过，工程交付等待验收，不进入Task7；详见Task6报告。

### Task 7：Critic独立审查、发布门槛及真实修订证明（约2.5h）

**Files:** `src/publishing/gate.ts`、`src/evaluation/{critic-cases,run-critic-eval}.ts`、角色prompt定稿、`tests/unit/gate.test.mjs`、`tests/fixtures/critic/`。

**Interfaces:** Review.target绑定七字段：inputHash、poolVersion、poolHash、counterReportHash、draftVersion、draftHash、evidenceSnapshotHash；另核验runId及真实Critic身份。`evaluatePublication`唯一发布资格入口。所有正文事实属于被审草稿；approve不允许blocking findings。

2026-10-31本轮结果：[Task7交付报告](../../implementation/task-7-publication.md)。476/476离线工程/Web通过；36计划实际29Run/58请求均在Critic前技术失败，7因safety hold未执行。下列模型质量及L05批准闭环验收目标未满足，Task7不整体PASS，Task8不开始；不将已有工程实现误记为真实Critic能力通过。

- [ ] 先写D01–D05与每个target hash单字段替换、重复/迟到批准、cancel后批准、Counter缺失、提案正文自封approved、第二次revise→insufficient、失败写盘不可发布的测试；`pnpm test:offline -- tests/unit/gate.test.mjs`先失败。
- [ ] 实现版本/角色/终态/完整输入门槛；系统ID/hash由程序生成，Review.target取派发时快照，不能将迟到回答重新绑定当前版本。Critic读取完整notes/authors、明确观察→finding→verdict，输入不含攻击期望标签，不继承Proposer对话；同模型偏差如实记录。
- [ ] 构建[15案矩阵](../../startup/critic-adversarial-design.md)的具体source manifest与攻击副本，保留基线hash/修改pointer/人工标签状态。确定性拒绝不进入LLM检出分母；来源先过检再观察L01–L07及C01–C03。
- [ ] live入口单独命令：`node --env-file=.env.local dist/server/evaluation/run-critic-eval.js --suite core --repeats 3`。每L/C主案3独立context（L06两变体分别3次），全局1Run/2模型permit仍生效，输出逐案n/N、漏检、误拒、技术失败，不能挑最好一次或用多数决冒充产品规则。
- [ ] 优先执行L05完整链：预检有效的C001-CH1/R1008草稿把局部论文结果外推成BACnet零误报→真实Critic精确定位C-GUARANTEE/E-IGMM并revise→一次补查产出v2删改保证及增加验证→同v2真实批准→确定性提案。v1批准用于v2必须被拒；若只得到insufficient，诚实记阻止发布但该“批准最终提案”目标仍未满足。
- [ ] 验收：D类全部拦截且合法对照不被无理拒绝；所有观测中的已知blocking错误无发布逃逸；每L类型至少一次精确检出且披露其他重复漏检；C01有来源支持的批准、C02正确不足；至少一条真实产物改变/阻断链可复核。失败不放宽标签，先修再针对性重测，旧失败也保存。
- [ ] live结果与离线回放分开标识，提交脱敏评测产物及回归。此阶段未通过不能把Critic作为已完成卖点。

### Task 8：本地HTTP、SSE、成果索引与导出（约1.5h）

**Files:** `src/server/{main,routes,sse}.ts`、`src/showcase/catalog.ts`、`src/evaluation/export-showcase.ts`；`tests/integration/{api,showcase}.test.mjs`。

**Interfaces:** HTTP路径、错误、SSE id及IPC严格按接口契约。Showcase只读已校验research成果，不触发模型；SSE从已保存seq补读，不重启任务。

- [ ] 先写非法company/challenge从属、路径穿越、重复event、断线后Last-Event-ID、cancel/approval竞争、队列满429、三份同pair不同challenge、adversarial混入、hash/Trace缺失的测试；运行看失败。
- [ ] 实现127.0.0.1服务、请求体限额、typed error、安全读取Evidence、串行存储→SSE推送、静态web托管。不将secret配置并入/api/catalog。
- [ ] 实现Showcase导出：候选run均research+runnerMode=live且approved、worker清理确认、当前hash/Review/Trace完整、不同pairKey≥3才生成manifest；至少一份真实Proposer/Counter推理区间重叠>0；拒绝offline fixture、adversarial和无并发证据，其余错误说明原因。
- [ ] 测试通过、重复导出幂等；无key时读历史成果仍可用，POST新run明确提示模型配置缺失；记录并提交。

### Task 9：真实事件前端与统一Proposal Showcase（约2h）

**Files:** `web/src/{main,App,api}.tsx`、五个components及`styles.css`；相关纯状态测试/接口测试。

**Interfaces:** 消费Task8 API与共享契约；渲染数据、状态和版本，不自行推断Agent已完成/已批准，不由UI生成虚假trace。

- [ ] 使用frontend-design与vercel-react-best-practices前先读取实际已安装Skill。先实现ChallengePicker→Run状态/取消→实际SSE最小路径，后做视觉，不装额外动效/图谱库。
- [ ] Timeline只显示真实queued/running/tool/failed等事件和重叠；Evidence Inspector显示来源、原文、hash/冲突/全文入口；Decision Evolution显示v1/v2差异、Critic finding及哪些被解决。
- [ ] Showcase首屏三张不同配对真实历史卡，直接进入每份提案/Trace/Review，未生成三份时明确空状态或数量不足，不放placeholder伪造完成。对抗验证单独区块并标故障注入，不能计为正式提案。
- [ ] 运行`pnpm build:web`；用本机可用browser Skill实际操作企业/挑战、队列/取消、SSE断连重连、证据和回放、三卡导航及错误状态。未实际浏览器检查不能写UI验证通过；没有agent-browser CLI时用宿主浏览器能力，不假装调用缺失工具。
- [ ] 核对无隐藏新事实、无模型key进浏览器bundle、无动画冒充完成后提交；页面美化不能替代Task7门槛。

### Task 10：三份真实成果、交付与清洁复现（约2h）

**Files:** `artifacts/showcase/`、真实脱敏eval/run材料、README、架构图、提交检查表；需要的setup与导出说明。

**Interfaces:** 由Task8 `exportApproved`生成最终Showcase manifest；每个pair保持完整来源/批准/Trace，任何过期批准不导出。

- [ ] 对开发/演示候选逐案核实来源后跑真实research Run，得到至少3个不同companyId/researcherId配对的approved提案。三个已读锚点只是候选，任何insufficient不强行变批准或计数；若失败换有证据的不同配对，保留失败记录。
- [ ] 单独保留Task7真实Critic变化链，对抗/历史标识明确；导出三份正式提案及各自Trace/Evidence/Review。检查所有正文事实与被审版本一致。
- [ ] README包含用途、架构、Windows启动/构建、固定数据setup、密钥配置模板、离线测试与live命令、真实并发说明、EINSTEIN network/Stars集成设想、合成数据与限制。架构图匹配真实实现，不声称已接入没有调用的网络API。
- [ ] 从干净临时目录按说明执行setup/build/test/start；无key可打开Showcase和历史材料，有用户本机key才跑明确live核验；不复制key进验收包。运行中的新数据/进度与回放身份区分。
- [ ] 检查无本地密钥、嵌套.git、node_modules或未脱敏日志进入提交候选。记录真实结果与未验证项；准备可审查的仓库/交付，公开发布或对外操作按用户授权另行处理。

## 依赖与时间预算

截至本轮官方复核时北京时间2026-10-30 17:46，距11-01 03:00约33小时。下面是工程估计，不是已经耗时或完成保证；实施开始时重新计算剩余时间，预留睡眠/休息和提交窗口，不靠取消可靠性验收赶进度。

| 阶段 | 任务 | 估计开发/验证时间 | 必过关 |
| --- | --- | --- | --- |
| 基础 | 1→2→3 | 3h | 固定版本、schema/hash、来源绑定 |
| 召回 | 4 | 2.5h | 全库/变体/截断解释，已判指标与未知分开 |
| 生命周期 | 5 | 2.5h | Windows ready前后清理、队列/permit、单一终态 |
| Agent闭环 | 6→7 | 5h | 真并发/工具与真实Critic修订及发布拦截 |
| 展示 | 8→9 | 3.5h | API/SSE/Showcase真实数据及浏览器验收 |
| 交付 | 10 | 2h | 三不同配对、Trace/Review、干净启动 |
| 缓冲 | 根因定位/审查反馈/打包 | 3h | 不以隐藏失败换完成 |

总计约18.5h工作+3h缓冲；人工标注/网关抖动/Windows环境可能超出估计。Task4与Task5只有在Task2契约稳定后可分派并行，Task8只可先做契约测试；不提前批量生成依赖未稳定模块。每阶段集成仍按依赖顺序验证。

落后时依次缩减美化、非核心交互、统计图和额外评测扩展；固定三角色、真实并发、证据追溯、Critic真门槛、至少三配对和基本Windows清理不删。若剩余时间不足以完成必过关，直接告知实际缺口与影响，讨论范围/交付，不声称已经完成。

## 重点风险与处理

| 风险 | 在哪一关暴露 | 处理 |
| --- | --- | --- |
| 召回漏高价值人 | Task4多通道/变体/截断与人工已判集合 | 解释漏失，修dev规则；holdout暴露后不再假装未见，必要时讨论新增路线 |
| LLM Critic共同偏差/假独立 | Task7真实L/C对照与重复 | 读完整源、盲化故障标签，保留漏检；不用同模型三角色宣传异构 |
| 网关usage不全/失效/超时 | Task5/6请求permit与deadline | 次数/时间硬上限；unknown统计；用户换卡，无静默切模型 |
| Windows ready前泄漏/孤儿/PID复用 | Task5与本轮实测 | spawn即登记、身份核对、确认清理；不宣称/T能清所有已孤立子树 |
| 过期批准/取消后复活 | Task2/5/7状态与hash单字段攻击 | 父唯一写入口、终态不可逆、当前快照精确绑定 |
| UI只有动画/重连再请求模型 | Task8/9 SSE/回放验收 | seq补读、真实source和mode，历史不冒充live |
| 一口气产代码导致集成不可控 | 每个Task | 写针对性失败测试→最小实现→验证→必要独立审查→再推进；不先填全部模块 |

## 计划自审与当前状态

用户七项要求已对应：目录见上文；模块/数据/事件/IPC见契约v1；Mozaik实现见Task6；后前端通信见Task5/8/9；阶段/验收与风险/时间见各Task及表格。五个Review Focus均有对应负例和阶段门槛。

**Task1/2已验收，Task3来源/结构范围CONDITIONAL PASS；Task4工程接收/质量待验收/holdout封存；Task5工程验证通过待用户确认，Task6–10未开始。** 自然语言语义、真实Agent/Critic、Showcase、三份提案和业务UI未通过实现验收；本轮全局调度仅offline_fixture基础设施，来源Hash通过不等于语义支持。
