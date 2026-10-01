# Code Map for /src/core

## Responsibility
`src/core/` 是 SOFA ONE 后端的基础设施层（infrastructure layer），为所有 feature 模块提供两类共享的、全局可注入的底层能力：

1. **持久化（`database/`）**：唯一的 Prisma 客户端实例及其数据库连接生命周期，暴露生成的 Prisma 数据访问 API。不含业务逻辑，是 `@prisma/client` 的薄封装。
2. **链上/钱包执行门面（`openfort/`）**：封装 Openfort SDK 与链上（viem / ERC-4337 bundler）交互，是后端唯一的钱包/签名/交易执行入口。

核心安全约束：**私钥永不落盘/记录/返回/在本地派生**，全部签名委托给 Openfort TEE。本层不实现任何业务规则，只提供基础设施能力。

## Directory Map
```
src/core/
├── codemap.md            # 本文件（父目录地图）
├── database/             # 持久化层（见 database/codemap.md）
│   ├── prisma.module.ts  # @Global() 模块，导出 PrismaService
│   └── prisma.service.ts # PrismaService extends PrismaClient，管理连接生命周期
└── openfort/             # 钱包/签名/交易门面（见 openfort/codemap.md）
    ├── openfort.module.ts    # @Global() 模块，导出 OpenfortService
    ├── openfort.service.ts   # OpenfortService + 导出类型（SanitizedReceipt 等）
    └── openfort.service.spec.ts
```
`src/core/` 本身不含直接生产代码，全部实现位于两个子目录中；详细文件级说明见各子目录 `codemap.md`。

## Design/Patterns
- **全局模块（`@Global()`）**：`PrismaModule` 与 `OpenfortModule` 均标记为全局，各自只提供并导出单一服务，使 `PrismaService` / `OpenfortService` 可在任意模块注入而无需重复 import。
- **继承 vs 组合**：`PrismaService extends PrismaClient`，将全部生成的 model/query/transaction 方法直接暴露在注入的服务上。
- **门面（Facade）**：`OpenfortService` 包装 Openfort SDK 客户端与 viem bundler 客户端，向调用方暴露高层领域方法（建钱包、校验会话/密钥、提交 UserOp、直发交易、安全回执查询）。
- **配置驱动 + 构造注入**：`OpenfortService` 构造器从 `ConfigService` 读取 `openfort.*` / `pimlico.*` 配置初始化客户端；`PrismaService` 直接读 `process.env.DATABASE_URL`（上游 `src/config/env.validation.ts` 已校验）。
- **生命周期钩子**：`PrismaService` 实现 `OnModuleInit`/`OnModuleDestroy`，在启动时 `$connect()`、关闭时 `$disconnect()`。
- **错误归一化**：`OpenfortService` 将所有外部失败经 `logOpenfortError` 记录并转换为带 `API_ERROR_CODES` 业务错误码的 Nest `HttpException`；`withTimeout` 用 `Promise.race` 提供超时保护。
- **判别联合结果**：`TransactionReceiptResult` 区分 `success` / `reverted` / `not_found` / `error`，供调用方区分终态与可重试态。
- **安全视图**：`SanitizedReceipt` / `SanitizedReceiptLog` 仅暴露计费所需字段，绝不返回 calldata、私钥、API key 或原始 provider/client。
- **链差异分支**：Monad 链走 Pimlico RPC（无 Openfort 赞助），非 Monad 走 Openfort RPC（可赞助），由 `isMonadChain` 分流。

## Flow
1. **启动**：`AppModule`（`src/app.module.ts`）imports `PrismaModule` 与 `OpenfortModule`；`PrismaService` 构造时绑定 `PrismaPg` adapter，`onModuleInit()` 调用 `$connect()` 打开连接池。
2. **持久化**：feature 服务注入 `PrismaService`，直接调用生成方法（如 `prisma.user.findUnique`、`prisma.$transaction`）完成所有 DB 读写；`wallet` / `withdrawal-policy` 等服务接受 `PrismaService | Prisma.TransactionClient` 以参与 `$transaction` 作用域。
3. **钱包/签名**：`OpenfortService` 提供 `createBackendWallet` / `createAgentWallet`（TEE 后端 EOA + 代理签名者）、`verifyIamSession` / `authorizeEmbeddedAddress`（会话与嵌入式地址归属校验）、`verifyAgentKeyRegistration`（Calibur EIP-7702 delegation + session key 链上校验）。
4. **交易执行**：`sendUserOperation` 按链选 RPC → 估算 gas 费用 → 挂 paymaster（可赞助）或估算 gas 上限（无赞助）→ `bundlerClient.sendUserOperation` → 等待回执；`sendBackendTransaction` 由后端 EOA 直发；`signData` 仅签名不广播。
5. **回执查询**：`getTransactionReceipt` 返回安全、可判别联合的 `SanitizedReceipt`，供计费对账使用；缺失/失败返回可重试的 `not_found` / `error`。
6. **关闭**：`onModuleDestroy()` 调用 `$disconnect()` 关闭连接池。

## Integration
- **接线**：`src/app.module.ts` 在根模块 imports `PrismaModule` 与 `OpenfortModule`（均 `@Global()`）。
- **`PrismaService` 消费方**（注入）：`auth`、`api-key`、`wallet`（含 `withdrawal-policy`）、`transactions`（含 `transaction-policy`）、`session-key`、`eoa-execution`、`mfa`、`step-up`、`security-events`、`security-notifications`、`billing`（含 `stripe`、`onchain/usdc-payment`、`billing-reconciliation`、`billing-entitlement`）、`health`，以及 guards `api-key-auth`、`openfort-user`、`either-auth`。
- **`OpenfortService` 消费方**（注入）：`auth`、`wallet`、`transactions`、`billing-reconciliation`，以及 guards `openfort-auth`、`openfort-user`、`either-auth`。
- **内部依赖（`common/`）**：`request-context`（`RequestContextService`，可选日志上下文）、`chains/supported-chains`（`getSupportedChain`、`isMonadChain`）、`errors/api-error-codes`（`API_ERROR_CODES`）、`utils/sanitize`（`sanitizeErrorMessage`）、`calibur/calibur`（Calibur 会话账户与密钥校验工具）。
- **外部依赖**：`@prisma/client` + `@prisma/adapter-pg`（Postgres）；`@openfort/openfort-node`、`viem` / `viem/account-abstraction` / `viem/actions` / `viem/accounts`（链客户端、bundler、paymaster、账户抽象）、`@nestjs/config`。
- **外部服务**：Postgres（`DATABASE_URL`）；Openfort API（账户/会话/签名/UserOp RPC）、Pimlico RPC（Monad）、各链 RPC。
- **配置项**：`openfort.apiKey`、`openfort.walletSecret`、`openfort.publishableKey`、`openfort.timeoutMs`、`pimlico.apiKey`、`pimlico.rpcUrls.<chainId>`、`DATABASE_URL`。

## Constraints
- **私钥安全**：私钥永不落盘/记录/返回/本地派生，全部签名委托 Openfort TEE。
- **安全回执**：公共交易状态响应不得包含 calldata、`requestHash`、`interactionsHash`；`SanitizedReceipt` 只暴露计费所需字段。
- **单一实例**：`PrismaService` 全应用共享一个客户端（无 per-request 客户端），通过 `Prisma.TransactionClient` 复用事务。
- **Schema 耦合**：数据模型定义在 `prisma/schema.prisma`；schema 变更后需运行 `npm run prisma:generate` 重新生成客户端。
- **配置校验**：`DATABASE_URL`、`openfort.apiKey`、`openfort.walletSecret` 为必填，由 `src/config/env.validation.ts` 校验。
- **测试**：`PrismaService` / `OpenfortService` 在 `*.spec.ts` 中广泛通过 `{ provide: ..., useValue: ... }` 或 `jest.mock` 模拟。
