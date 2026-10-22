# Code Map for /src/core/openfort

## Responsibility
封装 Openfort SDK（`@openfort/openfort-node`）与链上（viem / ERC-4337 bundler）交互，作为后端唯一的钱包/签名/交易执行门面。职责包括：
- 创建 TEE 后端钱包（EOA）与代理签名者（agent wallet）。
- 校验 Openfort IAM 会话、授权嵌入式地址归属。
- 校验 Calibur 代理密钥（EIP-7702 delegation + session key）的链上注册状态。
- 通过 Calibur session account 提交 UserOperation（含 Openfort/Pimlico 赞助与 gas 估算）。
- 通过后端 EOA 直接发送交易、签名数据。
- 提供安全（sanitized）的交易回执查询，供计费对账使用。

关键约束：私钥永不落盘/记录/返回，全部签名委托给 Openfort TEE。

## Files
- `openfort.module.ts` — `@Global()` 模块，仅提供并导出 `OpenfortService`。
- `openfort.service.ts` — 全部业务逻辑与类型定义（`OpenfortService` + 若干导出类型/接口）。

## Design/Patterns
- **门面（Facade）/ 服务封装**：`OpenfortService` 包装 Openfort SDK 客户端与 viem bundler 客户端，向调用方暴露高层领域方法。
- **构造注入 + 配置驱动**：构造器从 `ConfigService` 读取 `openfort.apiKey`、`openfort.walletSecret`（必填）、`openfort.publishableKey`（可选）、`openfort.timeoutMs`（默认 15000）初始化 SDK 客户端。
- **`@Optional()` 依赖**：`RequestContextService` 可选注入，用于日志上下文（`logContext`）。
- **错误归一化与安全日志**：外部失败转换为 Nest HttpException；signData 与 verifyIamSession 仅记录固定操作/失败分类，不记录 provider message、token 或 stack。IAM 明确 401/缺失身份返回 AUTH_PROVIDER_INVALID，超时或上游故障返回 502 AUTH_PROVIDER_UNAVAILABLE，不误清本地会话。
- **超时保护**：withTimeout 用 Promise.race 包裹外部调用；钱包操作按既有分类映射，身份校验超时单独归类为 AUTH_PROVIDER_UNAVAILABLE。
- **判别联合结果**：`TransactionReceiptResult` 区分 `success` / `reverted` / `not_found` / `error`，供调用方区分终态与可重试态。
- **安全回执视图**：`SanitizedReceipt` / `SanitizedReceiptLog` 仅暴露计费所需字段，绝不返回 calldata、私钥、API key 或原始 provider/client。
- **链差异分支**：Monad 链走 Pimlico RPC（无 Openfort 赞助），非 Monad 走 Openfort RPC（可赞助），由 `isMonadChain` 分流。

## Key Symbols
`OpenfortService`（`@Injectable`）：
- 私有字段：`client: Openfort`、`logger`、`timeoutMs`。
- 公开方法：
  - `createBackendWallet(): Promise<{ id; address }>` — 创建 TEE 后端 EOA。
  - `createAgentWallet(): Promise<{ id; address; keyHash }>` — 创建代理签名者并计算 secp256k1 key hash。
  - `verifyIamSession(accessToken): Promise<{ openfortUserId; email?; session }>` — 校验 IAM 会话。
  - `authorizeEmbeddedAddress(accessToken, walletAddress): Promise<{ openfortUserId; accountId?; address }>` — 校验嵌入式地址归属。
  - `computeSecp256k1KeyHash(agentAddress): Hex` — 由地址计算 Calibur key hash。
  - `verifyAgentKeyRegistration({ accountAddress; chainId; keyHash }): Promise<void>` — 链上校验 delegation + key 注册 + 可用性。
  - `getTransactionReceiptStatus(chainId, txHash): Promise<'success'|'reverted'|null>` — 简化回执状态。
  - `getTransactionReceipt(chainId, txHash): Promise<TransactionReceiptResult>` — 安全回执视图。
  - `sendUserOperation({ agentAccountId; accountAddress; chainId; keyHash; interactions; sponsorship? }): Promise<{ userOpHash; transactionHash|null }>` — 提交 UserOperation。
  - `sendBackendTransaction({ accountId; chainId; interactions }): Promise<{ transactionHash|null }>` — 后端 EOA 直发交易。
  - `signData(accountId, data): Promise<string>` — 后端钱包签名（不广播）。
- 私有方法：`assertCaliburContractAvailable`、`createBundlerClient`、`sendUserOperationWithSponsorship`、`estimateUserOperationFees`、`getUserOperationRpc`、`getMonadPimlicoRpcUrl`、`selectOpenfortUserOperationGasPrice`、`parseRpcBigInt`、`estimateUnsponsoredUserOperationGas`、`isMissingPaymasterPolicyError`、`createPaymasterPolicyException`、`logOpenfortError`、`createOpenfortApiException`、`createUserOperationException`、`isGasFeeTooLowError`、`isTimeoutError`、`isGasPriceRecommendationError`、`withSafeReason`、`sanitizeExternalErrorMessage`、`getErrorText`、`logContext`、`withTimeout`。

导出类型/接口：
- `SanitizedReceiptLog`、`SanitizedReceipt`、`TransactionReceiptResult`。
- 内部类型：`UserOperationGasPrice`、`UserOperationGasLimits`、`OpenfortGasPriceRpcResponse`、`OpenfortGasPriceRpcResult`、`UserOperationGasPriceLike`。

## Flow
1. **构造**：读取 env 配置初始化 Openfort 客户端与超时。
2. **钱包创建**：`createBackendWallet` → `client.accounts.evm.backend.create()`；`createAgentWallet` 追加 `computeSecp256k1KeyHash`。
3. **会话/归属校验**：`verifyIamSession` → `iam.getSession`；`authorizeEmbeddedAddress` → `accounts.list` 以 limit/skip 遍历稳定 total 的完整 IAM 账户集合，在分页/总量/时限边界异常时 fail closed；仅返回匹配账户的服务端非空 ID。
4. **代理密钥校验**：`verifyAgentKeyRegistration` → 建 viem client → `hasCaliburDelegation` → `isCaliburKeyRegistered` → `getCaliburKeySettings` + `getAgentKeyUsabilityFailure`。
5. **UserOperation 提交**（`sendUserOperation`）：
   - 取后端账户 → `toAccount` 包装签名器 → `createCaliburSessionAccount`。
   - 按链选 RPC（Openfort/Pimlico）→ `assertCaliburContractAvailable` → `estimateUserOperationFees`（RPC `openfort_getUserOperationGasPrice` / `pimlico_getUserOperationGasPrice`）。
   - 无赞助时 `estimateUnsponsoredUserOperationGas` 估算 gas 上限；有赞助时挂 paymaster。
   - `bundlerClient.sendUserOperation` → `waitForUserOperationReceipt` → 返回 userOpHash + transactionHash。
6. **后端直发**：`sendBackendTransaction` → `accounts.evm.backend.sendTransaction`。
7. **回执查询**：`getTransactionReceipt` → `getTransactionReceipt` + `getBlock` → 组装 `SanitizedReceipt`；缺失/失败返回可重试的 `not_found`/`error`。
8. **错误路径**：多数方法经 logOpenfortError；签名和身份校验使用固定分类安全日志，再按操作映射带 API_ERROR_CODES 的 HttpException。本地会话读写不调用 Openfort。

## Integration
- **消费方**：auth / wallet / transactions 等模块注入 `OpenfortService`（`@Global()` 导出）。
- **依赖（内部 common）**：
  - `common/request-context/request-context.service` — `RequestContextService`（可选）日志上下文。
  - `common/chains/supported-chains` — `getSupportedChain`、`isMonadChain`。
  - `common/errors/api-error-codes` — 钱包/执行错误及 `AUTH_PROVIDER_INVALID`、`AUTH_PROVIDER_UNAVAILABLE`。
  - `common/utils/sanitize` — `sanitizeErrorMessage`。
  - `common/calibur/calibur` — `createCaliburSessionAccount`、`getAgentKeyUsabilityFailure`、`getCaliburKeySettings`、`hasCaliburDelegation`、`isCaliburKeyRegistered`。
  - `common/calibur/calibur-primitives` — shared browser-safe `CALIBUR_ADDRESSES`、`hashKey`、`KeyType`；不通过 account factory 模块 re-export。
- **外部依赖**：`@openfort/openfort-node`（Openfort 客户端）、`viem` / `viem/account-abstraction` / `viem/actions` / `viem/accounts`（链客户端、bundler、paymaster、账户抽象）、`@nestjs/config`（`ConfigService`）。
- **配置项**：`openfort.apiKey`、`openfort.walletSecret`、`openfort.publishableKey`、`openfort.timeoutMs`、`pimlico.apiKey`、`pimlico.rpcUrls.<chainId>`。
- **外部服务**：Openfort API（账户/会话/签名/UserOp RPC）、Pimlico RPC（Monad）、各链 RPC（`getSupportedChain` 提供 transport）。
