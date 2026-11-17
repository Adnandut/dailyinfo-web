---
schema_version: 1
id: "ai_news-2026-11-18"
category: "ai_news"
date: "2026-11-18"
title: "DailyInfo ai_news briefing"
generated_at: "2026-11-18T04:30:49.839206+08:00"
published_at: "2026-11-18T04:30:49.839206+08:00"
item_ids: ["latentspace-057f5edb739afb8b0fea8bda", "latentspace-2ae8830717be898203ffe384", "latentspace-042f32d941ec7c71769078b5"]
---
# AI Daily Digest - 2026-11-18

## Cloudflare Joins the Jevolution and Labels Itself a Neolab

## 🧠 模型进展
- Cloudflare 发布两个 System One 模型 Clef 和 Clairic，正式从基础设施商延伸到模型研发。
- Clef 是受 TypeSafe AI 的 Jev 启发的决策模型，Cloudflare 称仅用两周完成构建。
- Clairic 被定义为首个 System One 提取模型，可在一次前向传播中从非结构化输入提取、计算、估计和预测值。
- Cloudflare 表示未来可能推出推理模型和其他 LLM，但重点在基于现有资源做后训练而非从零预训练。

## 🤖 Agent/产品进展
- Cloudflare 的 AI 平台从 Workers 计算、存储、Workers AI 模型服务逐步扩展到自研模型，并覆盖 Agent 运行场景。
- System One 模型的核心产品价值是低延迟，可在毫秒级完成部分任务，避免把所有请求都发送给 LLM。
- Clairic 针对 LLM 处理非结构化输入时易幻觉和返回畸形 JSON 的问题，提供类型化提取能力。

## 🔬 AI for Science
- 暂无重要进展

## 🏭 产业新闻
- Cloudflare 自称“neolab”，但作为有显著营收的上市公司，这一定义较传统 neolab 创业公司有所扩展。
- Cloudflare 第三季度营收 7.82 亿美元、同比增长 39%，年化营收突破 30 亿美元，并称其为公司最佳季度。
- Cloudflare 表示自研模型可降低 AI 业务风险，包括闭源模型不可运行、开源模型监管风险以及昂贵许可证等问题。

[查看原文](https://latent.space/p/cloudflare/)

# AI Daily Digest - 2026-11-18

## [AINews] Perplexity hits a $1B revenue run rate, up 4x in 2026

## 🧠 模型进展
- Qwen4-Max 正式发布，最高推理档在 Intelligence Index 升至43、平均任务成本降至3.27美元，并支持1M上下文与图文输入。
- 腾讯 Hy4 Flash 采用224B总参数、每token激活12B的多模态MoE，以低价提供1M上下文。
- EUROPA 在 JUPITER 超算上训练约952B参数MoE、每token激活32.8B，引发社区对其首模型规模的讨论。
- Liquid d1.2-ultra 在 Artificial Analysis Decision Index 排名第一，输入价格低至每百万token 0.042美元。

## 🤖 Agent/产品进展
- Perplexity 为 Computer 增加 Automations、Teammates 和 Mac 本地运行能力，并推出 Monitor API 与 Frontier Research。
- Claude Code 桌面版可在 iOS 模拟器运行 iPhone Duo 并折叠/展开测试布局，团队还公布了让 Claude 自验证工作的流程。
- Unsloth 让本地模型能够驱动桌面应用和游戏引擎，推进 computer-use 工具化。
- Hugging Face Inference Providers 接入 OpenRouter，开放模型可用同一端点和令牌调用。
- ChatGPT for Healthcare 增加 computer-use agents 和 20 多个插件，扩展医疗场景工作流。

## 🔬 AI for Science
- Gemini 4 Carbon 支撑 AlphaProof Code 验证 Signal 加密代码，并在湿实验纠错与蛋白序列发现中显示能力。
- Google 通过 Antigravity 向1万名科学家免费开放 Carbon，并将 Argon、Carbon、Hydrogen 的上下文窗口翻倍。
- OpenAI 向最多20万名科学家免费开放前沿模型，并报告1,800人研究显示科学家生产力约翻倍。
- 物理学家 Nathaniel Craig 用 GPT-6 Astra 提出标准模型的候选格点定义。
- Sage S2.1 Flash 作为开放权重科学模型，在 MLE-bench Lite 和 OfficeQA Pro 上报告领先结果。

## 🏭 产业新闻
- Perplexity 年化收入突破10亿美元、2026年增长约4倍，按 agent lab 倍数估算估值或达300-500亿美元。
- OpenAI 曾洽谈以超50亿美元收购可解释性初创 Goodfire，但后者倾向保持独立以服务多家实验室。
- Anthropic S-1 显示2026上半年收入163亿美元，算力成本占收入比例从251%降至48%。
- Noeri 融资1.1亿美元，Corma 以10亿美元估值完成1.25亿美元A轮。
- 美国商务部与司法部就涉及 Nvidia 的 Megaspeed 调查发表联合声明。

[查看原文](https://latent.space/p/ainews-perplexity-hits-a-1b-revenue-run-rate-up-4x-in-2026/)

# AI Daily Digest - 2026-11-18

## Building Visual Intelligence — Andreas Blattmann &amp; Dustin Podell, Black Forest Labs

## 🧠 模型进展
- BFL介绍FLUX 3，将静态图像、视频和音频三种信号联合训练，以构建对运动、时序和声音的视觉智能。
- FLUX 3的视频上采样器沿用同一骨干，强调时序一致性，避免逐帧增强导致播放时细节闪烁。
- FLUX Kontext支持在编辑中只改目标内容并保留图像其余部分，同时关注跨编辑和跨帧的身份保持。
- BFL讨论自回归与扩散路线的取舍：自回归可一次学习训练样本全部token，扩散可把长采样蒸馏为少步，取决于训练成本与生成等待。
- 团队利用视频中移动相机等线索学习物体多角度外观，并讨论世界动作模型及2027年机器人方向。

## 🤖 Agent/产品进展
- FLUX 3展示视频与声音联合生成demo，音频效果建议开启声音体验。
- FLUX Kontext提供图像编辑示例，可完成给衬衫加logo等局部修改并保持其余内容不变。
- FLUX被用户用于修复老旧退化家庭照片，成为团队未预设但真实发生的使用场景。
- BFL从图像生成产品扩展到视频生成、视频上采样，并探索世界模型/机器人相关产品方向。

## 🔬 AI for Science
- 暂无重要进展

## 🏭 产业新闻
- 核心团队从Stability AI spin out成立Black Forest Labs，并迅速推出Flux系列图像生成模型。
- Andreas Blattmann是Stable Diffusion共同创作者和潜在扩散方法共同发明者，Dustin Podell主导FLUX Kontext并是SDXL第一作者。
- BFL在FLUX 3上从图像生成扩展至视频与音频联合生成，并探索视频和世界模型的战略方向。

[查看原文](https://latent.space/p/bfl/)
