# 首版接口契约 v1

本文是已批准架构的实施契约。Task2共享schema、Hash和纯状态规则已实现，Task3来源/结构关系CONDITIONAL PASS，Task4工程已接收但人工质量未验收/holdout封存；Task5及Task6授权工程范围已由用户最终验收。本轮仅Task7独立Critic、父发布门槛及受控诊断，HTTP/SSE和业务UI未开始。应用接口与Mozaik原生API分开，后者以固定包实际导出为准。契约变化先改本文及消费者测试，再实现；重要语义变更先与用户讨论。

## 文件与边界

单个TypeScript/Node包，后端源码`src/`，前端`web/`，离线测试`tests/`，模型评测入口`src/evaluation/`。共享`src/contracts/`仅含类型/schema与常量，不导出Node文件系统、环境变量或密钥。Vite只允许导入这些共享契约。

持久化运行目录`var/runs/<runId>/`不自动提交；最终真实成果经校验导出到`artifacts/showcase/`，后者可随提交公开。`reference/`、`.cache/`、`var/`、`dist/`、真实`.env*`忽略。原数据由固定commit setup脚本获取，已有不同/脏版本不得覆盖；不自动拉取更新。

## 数据结构

以下字段是必要语义；具体Zod schema在对应模块实现，时间均ISO UTC，字符区间均Unicode code point零基半开。

| 类型 | 必要字段 / 语义 |
| --- | --- |
| RunInput | `companyId, challengeId`；服务端补`runId, datasetCommit, promptVersion, configVersion, mode=research/adversarial`，客户端不能改模型地址或注入提示词 |
| RunRecord | `runId, input:RunInput, inputHash, runnerMode=live/offline_fixture, status, createdAt, admittedAt?, deadlineAt?, revisionCount, cleanupState, lastSeq, reviewExpectation?, acceptedReview?, publishedDraftHash?`；inputHash来自不含runId/时间/密钥的规范输入快照；状态与runnerMode仅父进程写入，客户端/模型不能自封live |
| RunStatus | queued / researching / reviewing / revising / approved / insufficient / failed / cancelled；后四种终态不可逆 |
| CandidatePool | `poolVersion, poolHash, datasetCommit, query, expandedTerms, mergedCandidateCount, candidates[≤8], diagnostics`；同Run精查研究者ID并集≤8，补查固定原池；poolHash由规范化完整池产物计算 |
| CandidateProfile | `researcherId, rank, channels, matchedFields[{sourceRef, terms, score}], evidenceIds, identityFlags, restrictionRefs`；分数不表示个人价值 |
| RecallDiagnostics | `corpusCounts, channelStatus, facets, mergedCount, selectedCount, truncated, lowRecallReasons, judgedCapture?`；无人工分母则judgedCapture=null，不填虚假召回率 |
| SourceRef | `file, recordId, locator={format:"json",jsonPointer}`或`{format:"jsonl",line1Based}, fieldPointer, codePointRange?, derivedRecordId`；无原始ID的company-pages页面以来源行号派生内部键并标true；recordId和source_field绑定使用同一RecordId字符集 |
| Evidence | `id, datasetCommit, source:SourceRef, excerpt, excerptSha256, recordSha256, sourceFileSha256, canonicalizationVersion`；sourceFileSha256必填，不得以recordSha256替代 |
| Claim | `id, researcherId, kind=fact/inference/proposal, text, evidenceIds, sourceBindings[], limitations[]`；每个binding为`{evidenceId,subjectId,relation,objectId,fieldPointer}`，relation=author_of/profile_field/project_participant/patent_inventor/challenge_field/source_field。evidenceId必须在该Claim引用中，字段必须对应其SourceRef，结构化关系须有明确ID边；自然语言偷渡关系仍由Critic检验 |
| ProposalDraft | `runId, inputHash, pair={companyId,researcherId}, challengeId, version, poolVersion, poolHash, claims[], sections, evidenceSnapshotHash, draftHash` |
| CounterReport | `id, runId, inputHash, version, hash, poolVersion, poolHash, checkedFacets[], checkedCandidates[], findings[], noCounterEvidenceFound[]`；汇合时checkedCandidates须覆盖完整精查池且无池外/重复ID；“未找到”不等于“没有” |
| ReviewFinding | `id, scope=claim/run, claimIds[], evidenceIds[], code, severity=blocking/advisory, explanation, recheckQuestion?`；ID必须属于当前包；run级缺口可无claimId，不能伪造不存在的evidenceId |
| CriticReview | `id, runId, version, hash, verdict=approve/revise/insufficient, target={inputHash,poolVersion,poolHash,counterReportHash,draftVersion,draftHash,evidenceSnapshotHash}, findings[]`；approve不得有blocking finding，所有target必须对应当前run已保存的实际产物 |
| PublishedProposal | `id, pairKey, runId, mode=research, draft, reviewId, reviewHash, committedAt`；只有门槛和保存都成功后产生 |
| RunOutcome | `runId, kind=reviewed/insufficient/failed/cancelled, draft?, review?, counter?, reasonCodes[]`；worker的reviewed仅表示送父复核候选，不能直接设置RunRecord.approved |
| PublishDecision | `{allowed:true}`或`{allowed:false,reasons[]}`；输入必须是当前RunRecord、ProposalDraft、CounterReport、CandidatePool和CriticReview |
| Permit | `id, runId, requestId, grantedAt, expiresAt`；同requestId幂等，终态Run无新permit；释放不返还次数 |
| RawUsage | `source=gateway_reported, requestId, promptTokens?, completionTokens?, totalTokens?, cachedInputTokens?`；缺项unknown，无费用估算；不参与首版硬限额 |

Hash统一使用SHA-256、小写64位hex。canonicalization=`node-stable-json-v1`：递归按JS UTF-16键次序排序，数组顺序保留，UTF-8编码；有限数按JSON表示（-0为0），不做Unicode归一化，拒绝孤立代理项、undefined、bigint、Date、稀疏数组、访问器、symbol、非plain object和循环引用。键排序次序与正文code point区间是两个不同规则。`canonicalizeArtifact`只序列化、不删字段；`src/evidence/hashing.ts`使用Node crypto，不由前端导入。

| Hash用途 / 函数 | 精确输入和投影 |
| --- | --- |
| `sourceFileSha256` / `sha256Bytes` | 整个源文件原始字节，保留BOM/CRLF/LF；传入完整Uint8Array，Task3负责读取与核对，不能传单条record或解码重写的文件 |
| `excerptSha256` / `sha256Bytes` | 原文excerpt的UTF-8字节，不做归一化 |
| `recordSha256` / `hashSourceRecord` | 单条源记录完整canonical JSON；所有字段参与，包括源记录自身名为hash/createdAt的普通字段；不能用hashArtifact代替 |
| `inputHash` / `hashRunInput` | 严格RunInput仅排除runId，其他允许字段全部绑定；schema本身不接受时间/密钥 |
| `poolHash` / `hashCandidatePool` | 完整候选池仅排除根poolHash自身，包含diagnostics和候选次序 |
| `evidenceSnapshotHash` / `hashEvidenceSnapshot` | 完整Evidence数组、全部来源Hash、ID和次序，不在函数内部重排；拒绝重复Evidence ID |
| draft/counter/review产物 / `hashArtifact` | 完整plain JSON根对象，仅排除根层`hash,draftHash,createdAt,recordedAt,committedAt`；嵌套同名字段及根/嵌套inputHash、poolHash、Review.target全部参与 |

既有Python案例包的record hash采用独立规范，不与Node record hash混用；跨算法比较必须带版本。专用投影函数先验证完整原输入，不能将不合法字段投影掉再装作有效。

## 模块接口

Evidence.sourceFileSha256必填，取本Run快照中source.file整个文件原始字节的SHA-256，包含BOM与换行，采用小写64位十六进制，格式`/^[a-f0-9]{64}$/`。不能对解码/格式化后的JSON或仅一条record求值代替；缺失、格式错误或读取字节与声明不匹配都拒绝。Task1仅做文档一致性回归，运行时schema及源字节核验在Task2/3同步实现并测试。

| 文件 | 应用接口 |
| --- | --- |
| `src/data/snapshot.ts` | `loadSnapshot(root, expectedCommit): Promise<DatasetSnapshot>`；只读、固定Git对象/实际文件字节/ID/引用核验；`listRecords(kind): readonly LocatedRecord[]`按实际源次序返回完整冻结记录数组，不猜ID、不导出内部Map/bytes；单独loadTestSnapshot只接受明确测试副本manifest并标记test_copy |
| `src/evidence/store.ts` | `resolveField(ref,snapshot): ResolvedField`保留原始value/valueType与确定性text；`resolveEvidence(ref, snapshot): Evidence`生成完整来源Hash和应用ID；`createEvidenceSnapshot(list)`返回独立深冻结副本 |
| `src/evidence/validate.ts` | `verifyEvidence(evidence,snapshot): ValidationIssue[]`重新核对定位/内容/Hash/生成ID；`validateClaimSources(draft, snapshot, evidenceList): ValidationIssue[]`只读当前Evidence快照，重算其Hash并检查草稿绑定、ID与原始关系；第三参数为用户批准的Task3最小接口细化 |
| `src/retrieval/index.ts` | `buildIndex(snapshot): RetrievalIndex`，`retrieveCandidates(input,index,config): CandidatePool`；全库扫描/索引，最多8人交模型；`retrieveWithTrace(input,index,config)`另返回冻结的`{pool,trace,evidence}`，不扩Task2严格池schema |
| `src/evaluation/retrieval-report.ts` | `runRetrievalReport({split:'dev',output})`只读原始快照并写入新的本地输出目录；先保存源码/实际JS/查询/标签/配置/词表/index的freeze，再跑6题3阶段dev，拒绝holdout；指标入口`evaluateRetrievalMetrics`不把AI种子当人工标签 |
| `src/runtime/task-context.ts` | `createTaskContext(agentInstruction,input): ModelContext`；每任务新Context，原生DeveloperMessageItem和User消息契约 |
| `src/model/gateway-runner.ts` | `createGatewayRunner(config, permitClient, trace): InferenceRunner`；真实Mozaik输入/输出映射，最多一个function_call，默认无重试 |
| `src/runtime/orchestrator.ts` | `executeRun(start, emit, permitClient, options?): Promise<RunOutcome>`；受信第四参数注入模型配置/受控替身/已核验研究上下文及观察回调，不来自RunInput或IPC；应用wrapper通过原生事件完成，不await原生void runLoop当完成 |
| `src/publishing/gate.ts` | `evaluatePublication({draft,review,run,counter,pool,evidenceSnapshotHash}): PublishDecision`；纯函数，只决定资格，不写文件 |
| `src/supervisor/process-host.ts` | `start(input,snapshotPath,limits): WorkerHandle`立即登记fork句柄/PID；handle的identity/ready/closed分开确认，send严格IPC，terminate返回CleanupResult；清理依据同一原生handle出生时间，不盲杀旧PID，确认范围仅登记身份 |
| `src/supervisor/scheduler.ts` | `submit(input): Promise<RunRecord>`等待写盘确认；`cancel(runId): Promise<RunRecord>`、drain/waitForIdle/close；默认全局1活跃/3等待，满返回RUN_QUEUE_FULL；与设计v1.1一致，仅可信父配置/隔离测试可2活跃。safetyHold与cleanupEvidence显式可读，客户端和模型不能改limits |
| `src/supervisor/permits.ts` | `registerRun(runId,deadlineAt,admissionMono?)`、`acquire(runId,requestId): Promise<Permit>`、`release(runId,permitId): boolean`、stopRun/reclaimRun；全局2在途，每Run16次获准尝试，释放幂等不回补，跨Run拒绝；`timing`只给父本地单调期限，不扩共享Permit/IPC |
| `src/supervisor/deadline.ts` | `deadlineTimer({deadlineAt,deadlineMonotonicAt,now,monotonicNow,action}): {cancel()}`；稳定取消对象，按剩余时长重排。单调硬预算与UTC归档分开，不把时钟回拨变成额外额度 |
| `src/storage/run-store.ts` | `RunStore.open(root)`、createRun/saveRecord/getRun/listRuns；`appendEvent(event): Promise<StoredEvent>`、`commitOutcome(outcome,record,artifacts?): Promise<void>`、eventsAfter/close。串行磁盘确认后才可读；Task5拒reviewed发布/approved。SSE留Task8未实现 |
| `src/showcase/catalog.ts` | `listShowcase(): ShowcaseEntry[]`，`exportApproved(runIds,target): Promise<Manifest>`；复验3个不同pairKey、版本/hash/Trace，要求research+runnerMode=live，排除adversarial/offline_fixture；至少一份实际Proposer/Counter推理区间重叠>0 |

Review.target来源明确：inputHash=RunRecord.inputHash，poolVersion/poolHash=CandidatePool对应字段，counterReportHash=CounterReport.hash，draftVersion/draftHash=ProposalDraft对应字段，evidenceSnapshotHash=当前合并Evidence快照hash；review.id/hash来自保存后的完整Review。字段缺失或不同均不得发布。

系统ID、version与hash由应用协调器生成，模型只返回内容、verdict/finding和已给定源ID，不信任模型填写的控制元数据。汇合时把Proposer与Counter引用的Evidence合成快照，再计算完整draftHash并交Critic。Review.target在Critic任务派发时捕获，回答到达时不能重新绑定成新版本，否则会把迟到批准洗成当前批准。

Task2具体约束：模型Critic仅返回严格`{verdict,findings}`；协调器捕获`ReviewExpectation={actor:{role:"critic",agentId,taskId,contextId,attempt},reviewVersion,target}`，target七字段完整必填。Review绑定runId、reviewVersion和七字段；源/身份校验与hash重算通过后才能由可信父流程应用。`ProposalDraft.version`是每轮汇合的审查快照，首轮1、补查轮2；即使只补查Counter，也重新汇合draft2、更新hash再审。CounterReport是独立产物版本：未改可保留counter1供review2审查，其完整hash必须保持一致；改动任何字段（包括其version）须重新计算hash、重新审查，不为对齐编号伪造新版本。

`ArtifactBundleSchema`是纯契约集合，检查input/pool/draft/counter/review/Evidence声明的一致性、当前候选覆盖、所有Claim/Evidence ID引用以及binding对应的记录和字段。它不读取原始authors/参与者字段，不证明语义支持、不重算Hash、不授予发布权；Task3负责源字节与真实结构化关系，Task7负责实际发布门槛和保存确认。

状态规则由`transitionRun`实现：queued→researching→reviewing；approve只保存acceptedReview、保持reviewing；首轮revise→revising（revisionCount=1）→reviewing；次轮revise或明确不足→insufficient。cancel/fail可结束任何非终态。approved/insufficient/failed/cancelled不可重开；可信清理确认只更新cleanupState。新事件seq必须大于lastSeq，重复/迟到事件无新批准权。第二次审查固定原pool、同Critic身份但新task/context，draft2/hash必须变化。只有当前绑定的approve、confirmed cleanup和匹配reviewId/reviewHash/draftHash的可信publication_committed确认才能令状态approved。该纯规则不实现认证、磁盘提交或原子性，后续父流程承担这些保证。

`sourceBindings`只校验可声明的来源/关系事实：author_of检查完整authors非空researcher_id；profile_field要求同研究者字段；项目/专利检查明确参与者/发明人ID；challenge_field检查公司–挑战从属；source_field核对指定记录字段和原文。它不能把论文存在升级成与挑战相关，也不能自动理解所有正文。

Task3细化（用户已批准，不改变Task2数据结构）：

- official快照只接受固定commit；Git调用禁replace且不写索引锁，文件只按白名单只读。实际bytes须等于固定blob或其完整CRLF检出；sourceFileSha256始终Hash实际bytes，保留BOM/换行，不Hash重写JSON。解析后的记录/locator/诊断冻结，原文件后续变化不改变已装载快照；新装载须重新核验。test_copy仅用于明确测试副本，不证明官方真实性，也不能据此宣称live成果可发布。
- Evidence ID为应用对来源坐标/文件Hash/记录Hash/片段Hash生成的确定性ID；verifyEvidence也核对该ID，不接受模型自填别名。所有lookup用真实string ID，不按姓名合并，不将null/数值展示文本当ID。
- 真字符串采用原文，可选code point区间；null/数字/布尔/对象/数组用完整canonical JSON文本，不允许字符切片，ResolvedField仍保留原始类型/值。真正null与字符串null及不存在字段各自区分。空原文与超限片段属insufficient，不补写、自动截断或伪造Evidence；原记录完整保留可读。
- 输入evidenceList由createEvidenceSnapshot复制并深冻结，validate不改调用方对象；重算evidenceSnapshotHash须与draft一致。原始DatasetSnapshot不保存可变Evidence注册表。
- 身份关系必须由正确原始关系字段证明：author_of仅允许`/authors`及有效子路径，project_participant仅允许`/participants`及有效子路径，patent_inventor仅允许`/inventors`及有效子路径。按解码后的完整首token比较，拒绝同前缀/转义后不同的相邻字段；title/abstract/summary等不能借同记录ID证明这些身份关系。完整关系数组须包含明确匹配的researcher_id；具体槽位须该槽位ID匹配，不借姓名、其他槽位或其他字段补全身份。profile.publications仅证明profile列出该ID；反向不对称保留诊断，不升级成author_of，也不使整个数据集失败。challenge_field核对被指向challenge的真实ID。以上通过不代表自然语言语义支持已通过。
- source_field的subjectId为源记录ID；自指objectId只证明该记录字段，返回CONTEXT_ONLY_NO_CANDIDATE_RELATION警告；objectId指候选则必须同Evidence另有实际有效显式身份binding，否则CANDIDATE_RELATION_UNPROVEN。背景材料即使文字假称作者，也只能报告来源真实/候选关系未建立/SEMANTIC_SUPPORT_UNASSESSED，不声称确定性识别全部文字造假。
- ValidationIssue按source、location、relation、insufficient、semantic_review分类，并给severity/code/claimId/evidenceId。无error只说明来源和所声明结构检查通过，不等于语义支持、Critic批准或发布资格。
- 原13案75段全保留：73段JSON/JSONL走生产定位，2段CSV只做原字节/原文/legacy hash历史回归并拒绝进入当前生产Evidence。这里不永久排除未来经明确批准的CSV或其他合法官方来源；本轮不扩当前SourceRef白名单。

`executeRun`分派Proposer和Counter同时运行、汇合后Critic；捕获model.answer后本地schema验证，再完成应用task。下一task通过下一轮事件循环调度，busy guard覆盖任务收口，不能在同一Agent的同步回调中立即复用活动Context。推理reject不能由raw runLoop外层同步catch捕获；由adapter报告失败并令隔离worker以失败退出，父进程收口。

## HTTP与SSE

Task7授权细化（2026-10-31）：worker增加严格IPC `review.dispatch={v,runId,kind,expectation:ReviewExpectation,snapshotHash}`，由原生Critic onStart捕获并先于task.started发送，模型不能填写。snapshotHash是实际交给该Critic Context的完整ReviewSnapshot之hashArtifact。父进程独立重建七字段target及完整加载快照，并要求同一已登记Critic的task/context/attempt与真实答复、产物、task.completed、review.completed收据一致；worker reviewed无直接发布权。

`evaluatePublication`的既有参数补充`evidence,snapshot,actor,now?`，进行纯来源/结构/Hash/版本/批准绑定复验。`RunStore.commitPublication`是父端专用原子提交路径：内部再次调用同一资格函数，不接受裸approved记录；终态、完整审查证明、确定性完整草稿渲染在同一terminal.json提交。`getPublication`只有成功rename后可读，重启须复验来源与证明；失败/未完成进入hold，不能自动提升。取消/期限检查持续到最终rename临界区，临界区后到达的取消不能撤销已保留的原子提交。

adversarial/offline_fixture的approved仅为标记清楚的诊断产物，不生成正式PublishedProposal；仅research+live可有正式提案，Showcase额外筛选仍待Task8。最终正文为被审完整draft的canonical-json-draft-v1渲染，所有sections/claims/limitations保留，发布后无模型改写。此细化不更改Task2核心对象或Hash规则。

Node HTTP绑定`127.0.0.1`；JSON请求体≤1MiB、schema验证、拒绝未知路径/方法。默认不开放公网。开发时Vite代理`/api`；构建后Node提供`dist/web`静态文件。

| 接口 | 结果 |
| --- | --- |
| GET /api/catalog | 合成数据标签、企业及对应挑战，不含key |
| POST /api/runs | body={companyId,challengeId}；202 RunRecord；400非法关系，429队列满 |
| GET /api/runs/:id | 状态、进度、已保存产物引用；404不存在 |
| POST /api/runs/:id/cancel | 202取消已受理/同终态幂等；已approved等不可变终态409，不删除产物 |
| GET /api/runs/:id/events | SSE，事件名run-event，id=`runId:seq`；Last-Event-ID补读已存日志，不重启任务 |
| GET /api/runs/:id/artifacts | 版本化草稿、CounterReport、Review与最终提案引用 |
| GET /api/runs/:id/evidence/:evidenceId | 经服务器解析的原字段/片段/flags；不接受任意文件路径 |
| GET /api/showcase | 已批准、已复验的真实research成果索引；无自动模型请求 |

错误统一`{code,message,runId?,retryable}`，不含堆栈/请求header/key。SSE重连只补发seq之后事件；客户端去重且验证runId。历史回放与实时badge分别显示。

## IPC与事件

父→worker：`start {runInput,snapshotPath,limits}`、`permit.granted {requestId,permitId}`、`permit.denied {requestId,code}`、`cancel {reason}`。

worker→父：`ready {runId}`、`event {runId,nativeOrAppEvent}`、`artifact {runId,typedArtifact}`、`permit.request {runId,requestId}`、`permit.release {runId,permitId}`、`outcome {runId,typedOutcome}`。全部带`v=1`并经schema验证，worker不得自行指定写盘路径或环境变量。父只接受自己spawn且身份匹配的worker消息。

StoredEvent=`{schemaVersion:1,runId,seq,at,elapsedMs,source:mozaik/application/model/supervisor,type,agentId?,loopId?,taskId?,attempt?,payload}`。父分配seq、脱敏、限制payload体积并写盘，随后推送。原生事件type取4.2.0实际值，不能把application审查/发布事件说成Mozaik内置API。

Task2的StoredEvent还允许固定三角色`role?`与`contextId?`；loop/task事件必须提供agentId、role、loopId、taskId、contextId和attempt，participant/message基础事件可无task上下文。Task7离线修复后20种worker事件（此前19种，新增应用批次审计）与10种supervisor事件采用严格source/type/payload判别联合；payload只给出产物引用、状态或usage元数据，不接受原始提示词/模型正文/推理流。`task.completed`和`artifact.validated`的role须对应产物kind（proposer→proposal_draft、counter-evidence→counter_report、critic→critic_review）。WorkerEvent无seq/at/elapsedMs，不能发送supervisor状态；父持久化时才能添加这些字段。IPC所有外层runId与内层产物/事件/outcome的runId必须一致。格式校验不替代Task5/6的实际worker身份绑定、Task8脱敏/大小限制和持久化确认。

发布顺序：worker给出通过review的typedOutcome → 父确认worker正常收口/清理完成 → gate重新核验当前版本 → 原子保存批准提案和终态 → 更新Showcase。取消与完成竞争通过父的单一状态写入口裁决；取消先成终态则迟到批准仅记ignored事件。

运行180秒从admission开始含启动，等待120秒独立计算。spawn返回即登记PID/创建时间；ready前后的失败都清理。request40秒从permit获准并开始fetch算，排队中的permit不能绕过Run deadline。worker退出时回收permit，但未确认清理不得放行更多Run。父IPC断开时worker自行abort并退出；硬崩溃/孤儿边界按Windows报告实施测试，不声称OS级JobObject保障。

Task5实现细化（不改Task2字段）：submit由同步草图细化为等待磁盘的Promise；release显式接收可信Run归属。出生身份异步核对前，fork句柄/PID立即登记，唯一Run命令行标记防止初次查询串到其他worker。单调时钟从admission捕获；180/120/40截止停止工作/授权，但实际OS退出核验及终态提交可额外耗时，不宣称硬实时瞬杀。同步首停止意图先启动清理，写盘继续父串行；停止前收到的事实事件和产物保留FIFO，停止后新工作无权限。写盘恢复后再次检查hold/关闭/取消/期限才注册permit或fork。未确认清理、失败写入或重启unfinished/corruption继续hold；hardcrash遗留writer.lock不按旧PID自动删除。fixture全标offline_fixture，Context只是普通隔离对象，不冒充Mozaik业务验证。细节见Task5验收报告。

## Task7离线修复：工具协议与诊断（2026-10-31）

不改变Evidence、Claim、Review target、状态机或Hash。实际core4.2.0默认转换只选择首个function_call；生产Engine采用其公开`runLoop`第四参数`InterceptionHandler`桥接，最多8个原始call完整验证、按原顺序逐个交给原生Tool.invoke。下一次模型请求前须具备同一Context/真实task/actor/loop的全部原生回执；HTTP映射重建原始assistant批次及一一对应的真实tool输出。无桥接能力的standalone gateway仍拒绝多调用；不得将raw multi直接交给SDK。`parallel_tool_calls:false`继续保留为供应方提示，但不是本地执行保证。详见离线修复计划及实际SDK对照测试。

`tool.batch.updated`为application事件，带完整agent/task/context/attempt/loop归属。payload为`{kind:"tool_batch",batchId,phase,calls}`，phase=staged/progress/completed/cancelled/failed。每项call保留callId、allowlisted toolName、argumentsSha256、started、returned和可选outputSha256；ID唯一、returned须已started且有真实output hash，completed须所有call已returned。取消未执行的call保留在清单，不虚构回执。清单本身不赋予可信工具执行或发布权限，Engine还须核验原生对象/内容/Context。

model.request.started/completed/failed可带`GatewayDiagnostic`：stage、httpStatus、choiceCount、toolCallCount、allowedToolNames、returnedAllowedToolNames、unknownToolNameCount、finishReason、finishReasonPresent、usageStatus。无法安全观察的数量为null；未列入请求allowlist的工具名只计数，不记录原文。finishReason只保留受控枚举或other；不记录provider任意文本。usageStatus=reported/missing/invalid/not_available。有效usage独立于协议/HTTP业务接受结果；失败仍是failed，缺失仍unknown，不回推历史值。凭据反射先阻断全部内容投影，响应流仍受1MiB限额。

单次请求结束时间保留实际fetch/body结束区间；只有permit释放确认、取消复查及usage trace成功后才发送completed并返回业务结果，sink/release异常返回明确失败。任意外部sink若先写后抛错仍可能留有歧义外部记录，不能声称跨外部系统原子性。协议/身份/Context/清理hold使批量立即停止，剩余固定Run ID标unexecuted且不调用执行回调。legacy live矩阵入口在读取凭据/store/worker前硬锁，后续解锁需要另行授权及先协议再单L05的实证；本轮不实现解锁。

后代扫描使用已验证直接父进程出生时间，可靠CIM时间早于该父出生且超过9个FILETIME tick的既有精度边界时，记录chronology_exclusion并排除该当前父子边；排除祖先不继续遍历。其他条目仍需原生身份与CIM时间相符。时间缺失/权限失败/PID复用冲突仍unknown，普通重扫不消除sticky hold。新增时间诊断不改变原生身份终止、停止扫描屏障或未知清理阻止配额回收的规则。

## Task7限定人工风险接受与有界验证（用户已授权）

本轮不改变Task2状态/Hash或生产发布gate。仅对Run `897203e4-d779-4c3e-8696-52ce718d537e`、request `fbb7f42d-4112-45b6-a7e8-e3dda1f35f11`、permit `91c620fb-0ace-4612-b6f7-caea267cfc90`，可信父端可显式传入`RunStore.open(root,{historicalRecovery:authorization})`并调用`applyHistoricalRecovery()`。授权policyVersion固定`task7-single-history-risk-v1`，包含精确storeRoot、原record/events/terminal/result/freeze字节Hash、最新证据路径/字节Hash、acceptedRisks和本机保存用户授权时间。

resolution只原子追加在同一store的`historical-recovery/<runId>.resolution.json`，标明历史cleanup没有确认、状态仍failed/unconfirmed、reservation只归档处置而非在当前管理器释放。原文件/事件/获准尝试次数不改；diagnostics全部保留，`unresolvedDiagnostics`仅将该准确已接受项排除出准入阻塞。其他错误/unknown/坏journal/pending仍hold；无显式可信匹配授权的重启不自信任journal。首次决策要求5分钟内观察，重启对已持久化决定核验原绑定而不追认当时cleanup。恢复不引用PermitManager；新管理器从空状态开始，不能扣历史1个reservation，也不删遗留writer.lock。

新验证scope为`task7s_bounded_protocol_then_single_L05`，旧批量入口继续硬锁。冻结模型/原网关、源码/JS/SDK/script指纹、授权Hash、输入/固定池、两个Run ID及policy/prompt版本；独占attempt先于store维护及请求，不重试或换ID。探针父cap4、L05父cap16，顺序总上限20，请求40秒/Run180秒/全局并发2。探针产物禁止发布；必须实际supplier返回至少一批多call，经原生全部按序执行、真实回执/同Context/后HTTP完整对应，模型最终JSON引用实际随机receipt，并确认清理及当前permit无残留，才能进入唯一L05。单call、错误或预算不足均不增加请求补成功，L05标unexecuted。

L05只运行原受控adversarial案例，最多一次修订；标签/expected finding不进入模型Context。`analyzeL05Chain`只是本轮目标的事后结构观测，要求真实revise finding、claims/sections实际变化的v2、新Critic Context及准确v2批准/确定性诊断渲染；它不授予发布权、不修改产品gate、不把AI标签变成人工gold，也不能以结构链替代语义支持裁定。人工0/质量NA/holdout封存，Task8仍未授权。

## Task7t：诊断与protocol-probe-v2（新版本，旧结果不重判）

可信`AnswerDiagnosticsOptions`仅由宿主配置：credential/maxCaptureBytes、异步write及可选模型schema validate。最终答案只有真实native actor/Context/loop及最后runner rowResponse的requestId/permitId绑定后才可捕获；假payload只记无正文的身份诊断。捕获先查完整原文及Unicode转义中的凭据，再按UTF8字节上限保存text、原文/保存片段SHA、原字节数/保存字节数、truncated和omissionReason；显式reasoning内容省略，不读provider envelope/headers/ReasoningItem。无安全正文时明确原因，不以任意异常原文代替code。

`answer.diagnostic`按actor/request分别记录native_identity、answer_capture、json_parse、schema_validation、evidence_write及native_observer未知fallback的受控code。capture写ack及JSON/模型schema先验后，保持真实model.answer在业务artifact/task完成之前；schema最终ack前不resolve。可信诊断Error不再被压成统一observer错误，未知hook仍保守记录受控fallback。异步写拒绝必须失败，不递归尝试失败sink；悬挂write可被abort/deadline越过，迟到ack不得恢复任务或发布权限。取消不能使未落证答案成为成功。

新版scope=`task7t_layered_protocol_then_single_L05`，独占目录/Run ID/attempt，旧Task7s freeze/result/summary及历史Proposer unknown保持原样。模型层严格JSON `{runId,challengeId,researcherId,receipts:[{toolName,receiptId}]}`，两工具各一次，按供应方实际调用/native执行顺序逐项比较真实随机UUID；不包含callId，不把1/2转成真实ID。传输层仍严格保留原callID、args、批次、原序、Tool.invoke、输出Hash、同Context及下一HTTP映射；允许两合法独立工具的任意供应方顺序，不重排，不放过单侧错序。

完整成功必须executionPassed、cleanupConfirmed、evidenceComplete、transportPassed、modelReceiptsPassed同时成立。非零exit只失败execution，不等于清理unknown；cleanup确认不代表探针成功。每actor最后真实请求须有且仅有capture/json_parse/schema成功诊断、准确原生答案与HTTP/父permit凭据。新启动只复验既有resolution，零apply/new risk；无新store/计数扣减。probe4/每Context2、L0516、总20/global2/40s/180s及最多一次修订不变，无重试/补跑。完整有效指令/契约、输入/来源、源码/JS/SDK/配置全部冻结后才执行；批量和Task8仍锁定。
