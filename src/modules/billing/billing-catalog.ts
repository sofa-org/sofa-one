import type { PlanId } from './billing-calculator';

/**
 * Plan catalog metadata (description + features) sourced from PRICING.md
 * section 5. Monetary values and allowances live in the calculator's PLANS;
 * this file only carries the human-facing marketing copy.
 *
 * Resource overage rates are the accepted Phase 1 values: API calls at
 * $0.001/call and active wallets at $0.01/wallet/month (PRICING.md §7).
 */
export interface PlanCatalogEntry {
  readonly description: string;
  readonly features: readonly string[];
}

const OVERAGE_NOTE_API = 'API 超额费率 $0.001/次';
const OVERAGE_NOTE_WALLET = '钱包超额费率 $0.01/钱包/月';

export const PLAN_CATALOG: Record<PlanId, PlanCatalogEntry> = {
  free: {
    description: '适合个人开发者、黑客松、测试网项目和早期 Demo。',
    features: [
      '基础钱包创建和管理',
      '基础 API Key 创建、撤销和轮换',
      '测试网优先，主网能力可受限开放',
      '基础交易状态查询',
      '社区支持或文档支持',
      '标准速率限制',
      OVERAGE_NOTE_API,
      OVERAGE_NOTE_WALLET,
    ],
  },
  starter: {
    description: '适合小型应用进入生产环境。',
    features: [
      '主网生产使用',
      '更高钱包、API 和 outbound volume 额度',
      '基础 webhook',
      '基础审计日志',
      '基础 IP allowlist',
      '邮件支持',
      '标准安全事件记录',
      OVERAGE_NOTE_API,
      OVERAGE_NOTE_WALLET,
    ],
  },
  growth: {
    description: '适合已有真实用户、需要稳定运营的应用。',
    features: [
      '多项目 / 多环境管理',
      '更完整的 API Key 权限配置',
      'Webhook 重试与失败记录',
      '高级交易限额配置',
      '用户、钱包、API Key 冻结能力',
      '更长审计日志保留周期',
      '工作时间优先支持',
      OVERAGE_NOTE_API,
      OVERAGE_NOTE_WALLET,
    ],
  },
  scale: {
    description: '适合增长期钱包、协议团队和 Agent 平台。',
    features: [
      '高级风控规则',
      '更高 API 速率限制',
      '安全事件筛选、导出和告警',
      'SIEM webhook 或安全事件外发',
      '多链生产支持',
      '更长幂等窗口和交易追踪能力',
      '优先技术支持',
      OVERAGE_NOTE_API,
      OVERAGE_NOTE_WALLET,
    ],
  },
  business: {
    description: '适合高交易量平台、B2B 钱包基础设施客户和资金调度场景。',
    features: [
      '自定义速率限制',
      '自定义交易策略和风控阈值',
      '专属 Slack / Telegram 支持',
      '定期安全和运营 Review',
      '更高审计日志保留周期',
      '财务对账和账单报表支持',
      '生产事故优先响应',
      'SLA 选项',
      OVERAGE_NOTE_API,
      OVERAGE_NOTE_WALLET,
    ],
  },
  enterprise: {
    description: '适合交易所、大型钱包、支付平台、金融级客户和需要专属合规支持的机构。',
    features: [
      '定制 outbound volume 额度和费率',
      '定制钱包、API、团队成员和项目额度',
      '专属环境或私有化部署',
      '专属 SLA',
      '专属客户成功和安全响应窗口',
      '自定义链支持',
      '安全审计支持',
      '合规、财务和运营报表',
      '专属风控策略和审批流程',
      OVERAGE_NOTE_API,
      OVERAGE_NOTE_WALLET,
    ],
  },
};
