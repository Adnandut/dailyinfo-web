---
schema_version: 1
id: "ai_news-2026-11-22"
category: "ai_news"
date: "2026-11-22"
title: "DailyInfo ai_news briefing"
generated_at: "2026-11-22T04:30:45.339125+08:00"
published_at: "2026-11-22T04:30:45.339125+08:00"
item_ids: ["latentspace-62e76e74df3d472b6f5b6cb5", "latentspace-6ffef385c6e176563e7c3bf4"]
---
# AI Daily Digest - 2026-11-22

## [AINews] Riemann Hypothesis proved...twice independently

## 🧠 模型进展
- Thinking Machines 发布 Apache 2.0 开源的 26.4B 参数 looped MoE Inkling 2 Mini，约 3.4B 激活参数、1M 上下文并支持图文输入，在 DeepSWE v1.1 和 Vals Index 上领跑 100B 以下开源模型。
- 腾讯开源 770B/49B 激活的原生多模态 MoE Hy4，支持 1M 上下文，并获 vLLM 首日 BF16/FP8 支持。
- Google 推出 Gemini 4 Neon 与速度型 Gemini 4 Hydrogen，Neon 在 Company Agent Bench 达 87.4%、Agent Arena 排名第 2。
- Microsoft Ignite 发布 MAI Code 2，宣称达到 Opus 5.5 约 96% 的性能而成本仅 5%。
- Cloudflare 以 Apache 2.0 开源 Clairic 与 Clairic-flash 发票收据抽取模型，支持文本、图像和最多 4 页 PDF 并可自托管。
## 🤖 Agent/产品进展
- Gemini 4 Neon 获开发者好评，FrontierCode 2.0 得分 46.2% 接近 Opus 5.5 的 47.3% 且成本约为三分之一。
- Gemini API 新增 Dynamic Tool Retrieval、Gemini 3.5 Transcribe 语音编辑公开预览和 GIF 生成。
- Microsoft Ignite 发布 Autopilot agent 与 Decision-1.1 路由，配合 MAI Code 2 更新开发者工具链。
- MIT CSAIL 论文提出 LM harness 通过上下文卸载、程序化工具调用和子代理保持局部同分布，HF 超级适配器将 SWE-Bench Pro hard 在 Hermes/OpenCode 上提升至 61%/67% 并减少 19–48% 工具调用。
- GrepMem 用追加日志加正则检索在 ContextBench 达 95–97%，Pro² Agent 在完整 MLE-Bench 48 小时设定下达 76.0% 奖牌率。
## 🔬 AI for Science
- Anthropic 数学家 Levent Alpöge 称与 Claude 合作证明 Riemann Hypothesis 及 GRH，仅发布约 1.3GB Lean 代码（约 25 万页等效），形式化陈述已被确认但仍在编译和待验证。
- 数学家 Alessandro Masullo 同时发布耗时 12 年、约 940 页的纯人类 GRH 证明草稿，仍需同行评审。
- OpenAI 发布 MedChemBench，用于评估模型在药物化学推理上的能力。
- Isomorphic Labs 获 50 亿美元 C 轮融资，继续推进 AI 药物发现。
## 🏭 产业新闻
- Anthropic 完成据称史上最大 IPO，定价融资 813 亿美元、含超额配售 935 亿美元，每股 83 美元。
- Trump 称与 Xi 就 AI 联合护栏达成一致，但未公布具体细节。
- 美国新规可能阻止 TSMC 和 Samsung 为中国 AI 芯片代工。
- Nscale 需许可证才能向 ByteDance 提供远程 GPU 访问，ByteDance 约占其 2025 年收入 73%。
- 在 Jensen Huang 辞职后，Trump 敦促 Nvidia 让其回归。

[查看原文](https://latent.space/p/ainews-riemann-hypothesis-proved-twice-independently/)

# AI Daily Digest - 2026-11-22

## The War Against Slop and an Emerging Weapon to Fight it: Formal Verification

## 🧠 模型进展
- 据报道，GPT-6.2 Astra 生成了 Smoktunowicz 间隙定理的首个 Lean 证明，显示前沿模型在形式化数学证明上的能力提升。
- 有报道称 Anthropic 数学家 Levent Alpöge 使用 Claude 证明了 167 年历史的黎曼假设，并将证明发布为 Lean 代码。
- Anthropic 曾用 Lean 形式化费马大定理，项目规模达 1300 万行，体现大模型辅助大规模数学形式化的潜力。
- Axiom Math 利用形式化验证为数学推理系统提供正确性反馈，以证明尝试改进后续模型训练。
- Anthropic 报告在 36 个小型验证任务上，Opus 5.5 达到 50% 解决率且比 Opus 5 少用约 40% token，显示验证任务上的模型效率提升。

## 🤖 Agent/产品进展
- &Truth 推出首个工具 &Atlas，定位为从 C 语言开始的世界开源代码地图，用于代码安全与验证。
- &Truth 正在构建基于 Lean 的“验证机器”，目标是读取任意语言代码并证明其满足精确需求。
- Axiom Math 推出 AxiomProver 和 AXLE，分别用于生成 Lean 证明以及探索、验证和操作证明。
- Harmonic 的 Aristotle 作为自动定理证明器，由 AI 写证明、Lean 校验每一步。
- &Truth 提出从“vibe-coding”转向“veri-coding”，让验证层接入编程 Agent 工作流，以减少返工并提升首次正确率。

## 🔬 AI for Science
- 形式化验证正成为 AI 数学研究的重要基础设施，AI 生成证明后由 Lean 等证明助手检查正确性。
- 多个前沿模型已用 Lean 攻克高难数学问题，包括 Smoktunowicz 间隙定理和费马大定理的形式化。
- 黎曼假设若经同行验证，将成为 AI 辅助数学证明的标志性案例，目前报道仍以个人声明和 Lean 代码形式出现。
- Axiom Math 将形式化验证反馈用于训练数学推理系统，探索以可验证证明推动“超级智能”式数学能力。
- Harmonic 的 Aristotle 将 AI 证明生成与 Lean 逐步校验结合，降低定理证明结果依赖模型自身正确性的风险。

## 🏭 产业新闻
- 新创公司 &Truth 进入形式化验证赛道，由 cvc5 共同创作者 Clark Barrett 联合创立，重点面向代码内存安全。
- Harmonic、Theorem、Axiom Math 与 &Truth 等公司正围绕 AI 形式化验证和自动定理证明形成新兴竞争格局。
- Theorem 与 Anthropic 合作发布博客，称 LLM 正让形式化软件验证首次有望扩展到更大规模。
- 形式化验证被定位为对抗 AI 生成低质量代码“slop”和网络安全威胁的关键商业方向。
- Anthropic 的 Opus 5.5 在验证任务上展现出更高 token 效率，可能降低形式化验证规模化应用的成本。

[查看原文](https://latent.space/p/formal-verification/)
