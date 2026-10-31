# EINSTEIN 首版设计 v1.1

2026-10-30。用户已原则批准原设计，并明确保留固定三 Agent、真实 Mozaik 并发、独立 Runtime/State/Context 与子进程、证据/版本/hash、Critic 三种路由及最多一次补查、本地优先。这些是实施约束，不任意更改。本版按用户五点反馈修订，进入正式 Implementation Plan；本轮不创建产品脚手架或安装产品依赖。

独立 builder review 已返回“nothing important left”：未发现制定实施计划前仍必须补问的关键缺口。这是设计可规划性检查，不是产品运行或安全验收。

## 目标与边界

用户从官方数据选择企业和一条挑战，看到两个 Agent 实际并发分析、证据与身份问题、Critic 的具体审查意见，以及有来源的合作提案。允许“证据不足”，不要求每次找到可合作对象或每次必然被驳回。

用户已选：固定三 Agent，最多一次定向补查；证据核验与审查变化为重点；先本地完整演示及可复现运行，公网部署后置。核心仅使用官方合成数据，不关联真实同名人物，不发邮件或联系研究者。

首版每次运行生成一个主要企业–研究者配对及一份完整提案。官方公开条文要求至少三份提案、三个不同配对，没有要求同一次 Run 生成；分别运行后统一展示是我们基于公开条文的解释，不冒称组委会另行书面确认。配对按 companyId+researcherId 去重，更换同一配对的 challenge 不算新配对。提案字段包括挑战、候选及机构证据、技术关联、支持/反对证据、验证步骤、合作阶段、参与限制和未知项。未知预算、TRL、专利权属、商业回报不得编造；建议和假设与数据事实分开。[2026-10-30 官方复核](../../startup/proposal-delivery-verification.md)

首版有挑战选择、统一 Proposal Showcase、真实 Timeline、Evidence Inspector、版本变化及提案视图。Showcase 打开即可看至少三份已批准成果，每份链接本身的历史 Trace、Evidence 和 Critic Review；不要求评委执行三次模型任务才看到成果。局部 Research Network、动态研究图、真实科研 API、Funding 和 Outreach 均后置。合成数据标签需始终可见；不把合成论文当真实外部引用或生成 DOI。

## 比较过的路线

| 路线 | 收益 / 成本 | 决定 |
| --- | --- | --- |
| 固定 Proposer、Counter-evidence、Critic | 闭环短、职责和预算可控；复杂挑战的拓展能力有限 | 用户已选 |
| 按缺口动态增加研究 Agent 的任务图 | 灵活展示研究分解；增加调度、合并、重复检索和循环验证成本 | 用户未选，后置 |
| 同一服务进程内运行所有 run | 少一个 IPC 层；未处理异常可影响服务和其他运行 | 可行替代，未选定 |
| 每次 run 一个子进程，内部同一 Mozaik Runtime | 异步异常、挂起可由父进程收口；多一些进程和日志协议 | 用户已原则批准，Windows 边界须实测 |

新 defineRuntime + 新 State 的隔离已实测，不以“Mozaik 是全局 singleton”为选子进程的理由。建议子进程源于异步异常、超时边界和独立终止能力。

## 建议技术栈与组件

推荐 TypeScript/Node 后端、React/Vite 前端、固定 @mozaik-ai/core@4.2.0。前端只请求本地后端，密钥只在服务端环境变量中使用，不使用 VITE_ 等公开前缀。前端与运行状态以真实后端事件驱动。

后端薄 HTTP 层启动/查询/取消 run，提供证据和提案，使用 SSE 推送已记录的事件。编程协调器负责预算、版本和发布门槛；它不是第四个 AI Agent。每个 run 子进程里创建新 State、Runtime 和三个独立 Agent/context，不共用其他 run 的可变对象。

模型使用用户当前提供的网关与别名，凭据到期由用户更换，不反复询问有效期。接入走 custom InferenceRunner 的显式协议转换，不能用其他 Agent 框架代替 Mozaik。Codex 已验证路径保留为独立备选；不自动切换模型以掩盖错误。[有限工具契约实验](../../startup/gateway-runtime-verification.md)已真实通过：两个独立Agent、各一次原生工具、JSON回执、4请求和客户端重叠；不把它当通用adapter。产品需要将网关实际usage归一化到Mozaik及总预算，实验中的tokenUsage仍为undefined。

原始数据、索引与产物都保留本地文件：不先引入图数据库、向量数据库、队列或云服务。具体 HTTP 库、测试组织和样式细节可由实施者选择并记录；新增大型依赖仍需讨论。

## 一次运行的协议

1. **确定输入**：验证 companyId/challengeId 的从属关系，固定数据 commit、提示词版本、模型配置和预算，创建 runId；拒绝跨公司或不存在的 ID。
2. **准备候选池**：全库本地召回，三路统一为L0原词/BM25、L1受控转写、L2领域概念扩展；每路均可检索profile及有明确身份链接的论文/项目/专利，各保留最多40人，去重合并最多120人，再确定性排序选最多8人进入Agent精查。8是模型精查预算，不是全库扫描限制。保存原查询/变换来源、命中字段及分数、融合名次、截断和原因；不表示个人价值。当前无经人工审核的相关性gold或已证明Recall@8。[检索验证设计](../../startup/retrieval-validation-design.md)
3. **实际并发**：Proposer 与 Counter-evidence 都拿同一不可变输入/候选池，独立 Context，同时由真实 Mozaik 消息/事件启动。前者形成候选、主张和完整草稿；后者独立检查整池的归属、参与限制和反例，不等待前者完成后才假装并发。
4. **汇合后审查**：两者都完成且产物 schema/来源验证通过后，Critic 获得完整草稿、Claim/Evidence、反证及它们的精确版本。原生事件记录过程；结构化审查输出由确定性程序解析，不靠一段赞同文案当批准。
5. **处理审查**：approve / revise / insufficient 三种结果。revise 必须指出 claimId、原因和具体补查问题；仅允许一次定向重查，由 Proposer/Counter-evidence 针对相关项重新读取证据，创建新版本，再交同一 Critic Agent 新 Context 审查。不会创建第四角色或无限循环。
6. **发布门槛**：只有匹配当前输入、候选、提案、证据快照 hash 的批准才生效；正式提案仅确定性排版，不再用一个未被审查的新模型写作步骤添加事实。若第二轮仍 revise，转 insufficient；源错、超时或模型失败转 failed。两者不能冒充 approved。

每个 task 同时只允许一个 loop；要重查则前次终态后创建新 Context/任务 attempt，保留同一角色身份和可追溯的历史。既有 Context 不能在两个活动 loop 间复用。共享产物通过 Mozaik semantic event 传递 ID/版本并在 RuntimeState 由协调器唯一写入；Agent 只经只读工具取得源记录，不能直接改共享真值或发布提案。

同一Run的精查研究者ID并集最多8人，补查固定原池。池外线索记refinementSuggestion和低覆盖原因，必要时insufficient后由用户另开Run重新召回；不自动换入更多人、增加补查轮数或连开Run绕过预算。Review还必须绑定inputHash、poolHash和counterReportHash，不能只绑定草稿/Evidence版本。

## 证据与身份契约

Evidence 必须包含 datasetCommit、sourceFile、recordId、JSON pointer/JSONL 行号、字段路径、原文片段、Unicode 字符区间、片段 hash 及规范记录 hash。Unicode 区间采用 code point，前端/Node 不能用 UTF-16 偏移冒充同一约定。Evidence ID 由定位与内容 hash 确定。

sourceFileSha256必填：对快照中整个源文件原始字节（含BOM/换行）求SHA-256，使用小写64位十六进制；独立于原文片段及规范record hash。Task1先明确此规则和文档一致性检查，运行时缺失/篡改拒绝由Task2/3实现验收。

Claim 需要 claimId、文字、事实/推断/建议类型、evidenceIds、候选 ID 和限制说明。确定性校验核对 ID、来源、字段、原文、hash 以及证据所涉对象/字段和该主张是否对应；hash 正确的无关证据也必须拒绝。语义支持性由 Critic 和人工案例补足，不能声称确定性校验器解决了全部事实核验。

ID 为主键，不按姓名自动合并。profile→paper 不对称只标冲突，不能自动纠正作者；没有非空 researcher_id 的作者不能按姓名补链。肯定性的论文作者归属主张须有明确身份链接，profile 单边声明不能当作已核实作者身份。退休或离校需展示原文/时间及可参与方式，不等同于完全不能合作。

既有 13 案/75 段用于来源、同名、归属冲突、参与限制等人工审查起点；不是科研商业匹配 gold。正式评估还需人工审核相关/无关与证据不足案例，才可报告匹配质量。

## 状态、故障与预算

状态为 queued → researching → reviewing →（revising → reviewing，最多一次）→ approved / insufficient / failed / cancelled。后四者为不可逆终态。所有结果绑定 runId/taskId/attempt/产物版本；迟到、重复或过期批准只记日志，不能重开终态。

首轮硬限制：单 Run 180 秒（获准启动时开始计时，含启动开销）、单 HTTP 请求40秒、每 Run 最多16次获准请求尝试、单角色同时1 task、每个模型响应最多1个工具调用。全局默认只运行1个Run、最多3个等待Run、等待上限120秒；全局最多2个模型请求在途。父进程持有统一 admission/budget/semaphore，子进程必须申请并持有 permit 才能请求；计数在获准时递增，失败/取消也不回补。队列满拒绝新Run，排队取消不创建worker。多Run容量2只用于隔离测试或显式配置，不擅自提高默认值。

Token/费用**不是首版硬预算**。实验 tokenUsage 未归一化；网关已返回的usage可保存为“网关报告的部分/完整统计”，缺项记unknown，不造0、不推算费用、不把它称为准确扣费。先落实请求数、请求超时、Run总时长和全局并发，后续再完善Token统计。[已验证边界](../../startup/gateway-runtime-verification.md)

子进程异常/超时由父进程记录failed；取消记录cancelled并清理已确认属于该Run的进程。未确认清理则保留cleanup状态和调度安全锁，不能释放容量后继续堆任务。生产worker只执行本地只读工具与HTTP，不启动外部CLI或孙进程；不自动改用Codex产生新进程树。不承诺远端停止计费。无自动整段重跑；初版不做失败后原地恢复，用户可创建新runId。

基础设施默认无自动重试，避免重放副作用和扩大请求数；一次定向重查是审查流程，不是网络重试。工具都是本地只读，可在将来有证据后引入有限请求重试，仍需计入预算。

schema 错误、未知工具、多工具响应或非 JSON 产物，均记录明确失败，不凭修补字段伪造通过。工具参数需本地校验，不能以 Mozaik 默认 runner 或 provider 的 schema 声明代替实际参数验证。

## Trace、展示和复现

父进程顺序记录事件，再推送前端。事件包含 runId、seq、时间/elapsed、agentId、loopId、task/attempt、来源、原生 event type、产物/证据版本、允许保存的输入输出和实际 usage；不保存 Authorization、密钥或内部推理正文。应用事件与 Mozaik 原生事件使用不同 source 字段。

运行目录保存输入快照、版本化产物、JSONL Trace、最终状态及批准引用。终态/提案使用确认写入和原子替换；错误或崩溃只展示已保存部分，不声称断点自动恢复或完整日志永不丢失。SSE 断连可按 seq 补读已存事件，不能重启模型任务。

Timeline 展示实际重叠、工具、失败和审查；Evidence Inspector 可打开原字段、版本和冲突；Decision Evolution 比较 Claim/提案版本及审查原因。实时运行、历史真实回放和测试 fixture 明确区分。不得预写一次 Critic 驳回作为假实时剧情。

验收需包含：两个分析 Agent 真实时间区间重叠及消息/共享产物；至少一次模型产生的实质性审查意见确实改变产物或阻止发布；旧批准/无关证据/错误身份/超时/重复事件被正确处理；三组不同配对完整提案与同一运行的证据及 Critic Trace 可复核。实时模型若首轮正确，可展示批准，不为制造戏剧故意犯错；准备一段明确标为历史的真实审查案例。

最终提交还包括架构图、评委可访问运行的公开仓库与 README。README 解释用途、运行步骤、EINSTEIN network 和 Stars 接入；没有实际调用的部分明确标为集成设想。产品准备完成不自动授权公开发布或对外联系。

## 实施顺序与待确认项

先做文件数据/证据与只读工具、状态门槛及真实 Mozaik 闭环，再接最小真实事件页面，最后打磨视觉和三组可复现提案。先端到端走通一条真实挑战，不一次生成整套业务代码。

实现采用原方案的 TypeScript/Node + React/Vite、每Run独立子进程和每次一份主要配对提案；本轮先按用户要求完成修订及计划，不重复请求原则性架构批准。新的重要证据若使这些选择不成立，先解释原因/影响再讨论修改。

正式计划见[Implementation Plan](../plans/2026-10-30-einstein-mvp-implementation.md)。按模块逐步实现，阶段验收后推进。项目专属Skill按已验证API/契约编写；图谱Skill等图谱进入范围后再创建或启用，不为凑清单安装。

## 本轮五项补强与验证状态

### Proposal Showcase

用只读索引集中呈现已保存且通过发布校验的提案。每张卡包含配对、挑战、摘要、datasetCommit、runId、批准版本、证据快照和审查链接，标明真实历史运行；可继续发起新Run，不把历史回放冒充实时。展示索引只接受mode=research且approved的当前产物，不纳入fixture或对抗测试提案。导出前三份不同配对提案及各自完整材料时再做一次hash/版本/唯一配对检查。官方只明确一条完整Run Trace；保存每份完整Trace是我们的更高交付标准。

### 召回质量与证据充分性

相近技术、改写、缩写、拉丁/西里尔文都进入检索测试；姓名转写只用于查找，不能据此合并身份。保留开发集/冻结holdout、强相关/弱相关/无关人工标签及judged pool来源，报告Recall@8时必须有独立人工审查分母，不能以self-retrieval成功冒充语义召回。先与无扩展baseline比较，阈值在开发集校准并锁定，holdout不用于反复调参。

Coverage报告分开记录全库通道可用性、judged候选召回/精查池覆盖和每个候选的有效Evidence：有ID/摘要不等于支持技术主张。没有候选、无法验证来源、池中均无可用支持或关键身份冲突无法消除时输出明确原因的insufficient，不硬选排名第一；低分/窄通道但未证明无匹配则标low_recall，尝试一次确定性概念扩展重检后仍不足才停止。该检索扩展不增加8人精查上限，也不消耗Critic允许的一次定向补查。

### Critic 独立性及对抗验收

Critic用独立系统指令和新Context，直接读取规范来源与完整限制，不只接收Proposer摘要；不知道故障注入标签/期望答案。Counter-evidence覆盖清单与“查过未找到”的记录必须存在，缺反证不能等于已排除反例。同模型仍有相关偏差，不能声称模型异构独立。

对抗矩阵包括错作者、存在但无关论文、遗漏限制/未检查反证、技术越界推断、来源中的指令注入、自我背书、过期版本批准与合法对照。区分确定性precheck拒绝率、真实Critic检出率和最终发布拦截率；不能把precheck拦截归功于Critic。[案例与指标](../../startup/critic-adversarial-design.md)

必过关：一次明确标为对抗测试的真实模型运行中，v1注入的错误Claim被Critic定位到claimId/evidenceIds并revise；定向补查产生v2，相关Claim被删除或限缩，草稿及最终提案hash变化，v1批准不能发布v2，只有v2对应批准和保存确认才能发布。保存完整源、输入、提示词/模型配置、审查、事件与产物，可离线复核历史因果链；重新在线运行不保证逐字相同。产品门槛未实现前，不能宣称此验收已通过；展示与正式三份research提案分开。

### Windows 实测与实施门槛

新增独立fixture验证超时、取消、活父进程的孙进程树清理、异常隔离与多Run同时执行，验证PID创建时间及退出后状态，不把kill尝试当确认完成。父已退出时向旧PID发taskkill存在复用风险，必须使用记录身份的已知后代核对并清理，不能宣称/T自动发现所有孤儿。具体结果以[Windows实测](../../startup/windows-process-verification.md)为准。产品Supervisor尚未实现，其admission/permit/取消竞态和重启后处理仍须在对应阶段复测；fixture通过不等于产品通过。

| 项目 | 已验证事实 | 仍为设计或后续验收 |
| --- | --- | --- |
| 官方三份交付 | 本轮重新读取当前赛道与总规则；无同Run条款 | Showcase和三份真实research提案尚未生成 |
| Runtime/网关 | 两Agent、原生工具、JSON及客户端重叠通过；usage原始数字已记录 | 产品adapter/permit/预算尚未实现；无准确费用统计 |
| Evidence | 13案75片段、15篡改负例及同案字段绑定通过 | 自然语言语义支持和匹配召回未通过业务评测 |
| Critic | 只有协议和对抗测试设计 | 实质检出、阻断发布和真实v1→v2证据链尚未验证 |
| Windows | 本轮fixture最终5/5，Root独立复跑5/5；11个登记身份全消失，真实观察到detached后代可存活并按已知身份清理 | 首轮未ready原因未确定；产品多Run调度、主server硬故障与完整恢复不因fixture而自动成立 |

技术实证见[决策报告](../../startup/decision-report.md)、[故障边界](../../startup/runtime-failure-verification.md)、[证据案例](../../startup/evidence-casebook.md)、[Codex 实验](../../startup/codex-login-verification.md)、[网关探测](../../startup/gateway-verification.md)。本文尚未声明产品保护、UI、Critic 或提案生成已经完成。
