# SOFA ONE 收费方案

## 1. 定价目标

SOFA ONE 的定价参考 Fireblocks 等钱包与托管基础设施的公开模型，但主收费维度应回到 **outbound volume（出站交易量）**。

核心原则：

- 提供免费计划，降低开发者和早期项目接入门槛。
- 月费保持较低，主要覆盖平台、支持和基础资源成本。
- 以月度 outbound volume 作为主要收费维度。
- 免费 outbound volume 额度足够高，方便客户完成冷启动和早期增长。
- 超出免费额度后按阶梯费率收费，交易量越大，边际费率越低。
- 不按 AUM 作为公开主收费模型，避免客户因持有资产规模增长而产生额外心理负担。
- 不同 plan 不只是额度不同，也对应不同安全、支持、风控、审计和集成服务。

## 2. 计费口径

### 2.1 Outbound Volume 定义

Outbound volume 指客户通过 SOFA ONE 钱包和 API 发起的出站资产转移规模，包括：

- 提现到外部地址。
- 通过公共 API 提交并实际执行的链上交易。
- 由自动化 Agent 或后端任务触发的资产转出、合约交互和资金调度。

不建议计入：

- 入金 / deposit。
- 失败、被拒绝或仅模拟的交易。
- 无资产转移的状态查询、余额查询、API Key 管理操作。

### 2.2 费用计算

```text
月账单 = 套餐月费 + 超出免费 outbound volume 的阶梯费用 + 资源超额费用 + 增值服务费用
```

其中：

```text
可计费 outbound volume = max(月 outbound volume - 套餐免费 outbound volume, 0)
```

阶梯费率应按边际区间计算，避免客户因跨档导致整月费率突然上升。

### 2.3 钱包额度定义

钱包额度指套餐内可管理的 **活跃用户钱包数量**，不是资产额度，也不是交易额度。

一个活跃钱包通常指：

- 已由 SOFA ONE 为用户创建或绑定的钱包账户。
- 当月仍处于 active / usable 状态的钱包。
- 可以用于展示余额、接收资产、发起签名或提交交易的钱包。

不建议计入：

- 已删除、已归档或长期冻结且不可使用的钱包。
- 仅用于内部测试、未进入生产环境的临时测试钱包，具体可按 plan 政策豁免。

钱包额度的作用主要是覆盖底层钱包创建、索引、余额同步、审计记录和安全监控成本。它不是用户资产规模上限；客户钱包里的资产可以超过套餐钱包额度本身，真正产生主要费用的是 outbound volume。

## 3. 推荐公开套餐

| Plan | 月费 | 免费 outbound volume/月 | 钱包额度 | API 调用/月 | 团队成员 | 适合客户 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Free | $0 | $50K | 10 | 10K | 1 | 开发者、测试项目、早期验证 |
| Starter | $49 | $250K | 100 | 100K | 3 | 小型应用、早期生产环境 |
| Growth | $199 | $1M | 1,000 | 1M | 5 | 有真实用户和交易量的应用 |
| Scale | $799 | $5M | 5,000 | 5M | 10 | 成长期钱包、Agent 平台、协议团队 |
| Business | $1,999 | $25M | 25,000 | 25M | 25 | 高交易量平台、B2B 基础设施客户 |
| Enterprise | 定制 | 定制 | 定制 | 定制 | 定制 | 交易所、大型钱包、金融级客户 |

## 4. Outbound Volume 阶梯费率

超过套餐免费 outbound volume 后，按以下边际阶梯收取费用：

| 可计费 outbound volume 区间/月 | 边际费率 | 说明 |
| ---: | ---: | --- |
| $0 – $500K | 0.0100% | 初始超额费率，约 1 bp |
| $500K – $2M | 0.0075% | 早期增长客户 |
| $2M – $10M | 0.0050% | 规模化客户 |
| $10M – $50M | 0.0025% | 高交易量客户 |
| $50M – $200M | 0.0015% | 大型平台客户 |
| $200M+ | 0.0010% 起 | Enterprise 定制 |

> 注：这里的阶梯针对“可计费 outbound volume”，即扣除套餐免费 outbound volume 后的部分。

## 5. 不同 Plan 的差异化服务

### 5.1 Free

适合个人开发者、黑客松、测试网项目和早期 Demo。

包含：

- 基础钱包创建和管理。
- 基础 API Key 创建、撤销和轮换。
- 测试网优先，主网能力可受限开放。
- 基础交易状态查询。
- 社区支持或文档支持。
- 标准速率限制。

不包含：

- SLA。
- 专属支持。
- 高级审计导出。
- 自定义风控策略。

### 5.2 Starter

适合小型应用进入生产环境。

包含 Free 的所有能力，并增加：

- 主网生产使用。
- 更高钱包、API 和 outbound volume 额度。
- 基础 webhook。
- 基础审计日志。
- 基础 IP allowlist。
- 邮件支持。
- 标准安全事件记录。

### 5.3 Growth

适合已有真实用户、需要稳定运营的应用。

包含 Starter 的所有能力，并增加：

- 多项目 / 多环境管理。
- 更完整的 API Key 权限配置。
- Webhook 重试与失败记录。
- 高级交易限额配置。
- 用户、钱包、API Key 冻结能力。
- 更长审计日志保留周期。
- 工作时间优先支持。

### 5.4 Scale

适合增长期钱包、协议团队和 Agent 平台。

包含 Growth 的所有能力，并增加：

- 高级风控规则。
- 更高 API 速率限制。
- 安全事件筛选、导出和告警。
- SIEM webhook 或安全事件外发。
- 多链生产支持。
- 更长幂等窗口和交易追踪能力。
- 优先技术支持。

### 5.5 Business

适合高交易量平台、B2B 钱包基础设施客户和资金调度场景。

包含 Scale 的所有能力，并增加：

- 自定义速率限制。
- 自定义交易策略和风控阈值。
- 专属 Slack / Telegram 支持。
- 定期安全和运营 Review。
- 更高审计日志保留周期。
- 财务对账和账单报表支持。
- 生产事故优先响应。
- SLA 选项。

### 5.6 Enterprise

适合交易所、大型钱包、支付平台、金融级客户和需要专属合规支持的机构。

包含 Business 的所有能力，并可定制：

- 定制 outbound volume 额度和费率。
- 定制钱包、API、团队成员和项目额度。
- 专属环境或私有化部署。
- 专属 SLA。
- 专属客户成功和安全响应窗口。
- 自定义链支持。
- 安全审计支持。
- 合规、财务和运营报表。
- 专属风控策略和审批流程。

## 6. 示例账单

### 示例 A：早期项目

- 套餐：Free
- 月 outbound volume：$40K
- 免费额度：$50K

```text
可计费 outbound volume = $0
月费 = $0
超额交易量费用 = $0
月账单 = $0
```

### 示例 B：小型生产项目

- 套餐：Starter
- 月 outbound volume：$600K
- 免费额度：$250K
- 可计费 outbound volume：$350K
- 适用费率：0.0100%

```text
月费 = $49
超额交易量费用 = $350,000 × 0.0100% = $35
月账单 = $84
```

### 示例 C：规模化客户

- 套餐：Scale
- 月 outbound volume：$18M
- 免费额度：$5M
- 可计费 outbound volume：$13M

阶梯计算：

```text
前 $500K × 0.0100% = $50
$500K – $2M，即 $1.5M × 0.0075% = $112.50
$2M – $10M，即 $8M × 0.0050% = $400
$10M – $13M，即 $3M × 0.0025% = $75
```

```text
月费 = $799
超额交易量费用 = $637.50
月账单 = $1,436.50
```

### 示例 D：大型客户

- 套餐：Business
- 月 outbound volume：$90M
- 免费额度：$25M
- 可计费 outbound volume：$65M

阶梯计算：

```text
前 $500K × 0.0100% = $50
$500K – $2M，即 $1.5M × 0.0075% = $112.50
$2M – $10M，即 $8M × 0.0050% = $400
$10M – $50M，即 $40M × 0.0025% = $1,000
$50M – $65M，即 $15M × 0.0015% = $225
```

```text
月费 = $1,999
超额交易量费用 = $1,787.50
月账单 = $3,786.50
```

## 7. 资源超额费用

Outbound volume 是主收费维度，资源超额费用应主要用于防止滥用和覆盖基础设施成本。

| 项目 | 建议超额费用 |
| --- | ---: |
| 钱包数量 | $0.005 – $0.02/钱包/月 |
| API 调用 | $0.0005 – $0.002/次 |
| 团队成员 | $10 – $30/席/月 |
| 自定义链支持 | 一次性 $5K – $25K，或 Enterprise 定制 |
| 专属 SLA / 支持 | $1K+/月，或 Enterprise 定制 |

签名或交易提交建议默认并入 API 调用和 outbound volume，不单独叠加收费，避免账单过于复杂。

## 8. Enterprise 定价

Enterprise 不建议公开固定价格，只展示“Contact Sales”。可按以下维度组合报价：

- 免费 outbound volume 额度：$100M+/月，可谈判。
- Outbound volume 费率：0.01% – 0.02% 起，视规模继续下降。
- 最低年度合同：$24K – $100K+/年。
- SLA：99.9% 或更高。
- 支持：专属 Slack/Telegram、专属客户成功、安全响应窗口。
- 安全与合规模块：审计日志导出、SIEM webhook、定制风控规则、合规报表。
- 部署形态：共享云、专属环境或私有化部署。

## 9. 推荐官网展示版本

官网可用更简化的表述：

| Plan | Monthly | Free Outbound Volume | Overage Fee | Best For |
| --- | ---: | ---: | ---: | --- |
| Free | $0 | $50K/mo | 0.01%, decreasing by scale | Build and test |
| Starter | $49 | $250K/mo | 0.01%, decreasing by scale | Early production |
| Growth | $199 | $1M/mo | 0.01%, decreasing by scale | Growing apps |
| Scale | $799 | $5M/mo | 0.01%, decreasing by scale | Scaled platforms |
| Business | $1,999 | $25M/mo | 0.01%, decreasing by scale | High-volume teams |
| Enterprise | Custom | Custom | From 0.001% | Large institutions |

一句话说明：

> SOFA ONE uses a low-subscription, outbound-volume-based pricing model: generous free outbound volume allowances, usage-based overage, and lower marginal rates as transaction volume scales.

## 10. 设计取舍

- 相比 AUM 收费，outbound volume 更贴近 SOFA ONE 的核心价值：安全地执行签名、交易提交和链上自动化。
- 客户只在真实使用和资产转出时产生主要费用，不因资产静态持有而持续付费。
- 低月费降低接入门槛，免费 plan 适合开发者和早期项目。
- 差异化服务让高阶 plan 不只是买额度，也是在购买更强的安全、审计、支持和集成能力。
- 阶梯费率必须按边际区间计算，确保交易量越大，综合费率越低。
