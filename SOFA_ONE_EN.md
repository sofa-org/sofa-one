# SOFA ONE Overview

## 1. Overview

SOFA ONE is a server-side signing and transaction infrastructure built for on-chain automation and AI Agent use cases. It provides a user dashboard and developer-facing APIs, enabling applications to sign messages, submit transactions, track status, and maintain audit records without directly handling users' private keys.

Users can log in through the dashboard, bind wallets, deposit assets, withdraw funds, and manage API Keys. Programmatic clients can use API Keys to submit controlled signing or transaction requests. Wallet custody and signing are handled by a managed secure execution environment; the application itself does not store, log, return, or derive private key material.

## 2. Positioning

SOFA ONE is a secure middleware layer between user asset control and programmatic on-chain execution.

It is not a general-purpose wallet or a trading strategy platform. Instead, it is infrastructure that can be integrated by applications, AI Agents, backend jobs, and automation services. The project focuses on three goals:

- **Execute on-chain actions safely on behalf of users**: private keys do not enter the business system, and automation programs only receive limited API Key access.
- **Make automation manageable**: users can create, revoke, rotate, and restrict API Keys.
- **Make on-chain operations auditable**: signing requests, transactions, key lifecycle events, and abnormal behavior are recorded for traceability and risk control.

## 3. Problem Statement

On-chain automation often requires backend services or agents to execute transactions on behalf of users. Existing approaches usually face several issues:

- **High key custody risk**: if developers store private keys or hot wallets themselves, user assets may be exposed through service compromise, logs, or leaked environment variables.
- **Unclear automation permissions**: many systems lack a revocable, auditable, and permissioned Agent/API Key layer, making it difficult for users to control what automation programs can do.
- **Complex user experience**: users often need to understand wallets, signatures, gas, approvals, and chain switching, which raises the barrier for using on-chain applications.
- **Limited operational visibility**: on-chain operations often lack unified request records, idempotency controls, risk events, and status tracking.

SOFA ONE turns automated on-chain execution into an operational, integrable, and extensible service through a dashboard, API Keys, transaction policy checks, idempotency controls, and security auditing.

## 4. Target Users

- **Application developers / protocol teams**: teams that want to add on-chain automation to their products without handling private key custody and security boundaries themselves.
- **AI Agent / automation strategy developers**: builders who need to submit transactions, query status, or execute user-authorized on-chain actions through APIs.
- **End users**: users who want to use automation services while retaining control over wallets, API Keys, and asset operations.
- **Operations and security teams**: teams that need to investigate abnormal requests, review audit records, and manage key lifecycle and risk events.

## 5. Typical Use Cases

- AI Agents execute on-chain actions based on user-defined settings.
- Backend services submit EVM transactions through API Keys.
- Users create, revoke, or rotate API Keys from the dashboard.
- Users view wallet balances, deposit addresses, and transaction status.
- Teams audit signing requests, transaction submissions, and API Key usage.
- Applications integrate a unified on-chain execution API across testnets and mainnets.

## 6. Core Features

### 6.1 User and Wallet Management

- Users log in through a web dashboard and are synced into the local user system.
- Users can bind managed wallet accounts and EVM addresses.
- The system tracks Agent authorization and registration status per chain.
- The dashboard shows wallet status, balances, deposit information, and withdrawal entry points.

### 6.2 API Key Management

- Users can create, view, revoke, and refresh API Keys from the dashboard.
- Plaintext API Keys are returned only once during creation or rotation.
- The service stores only irreversible key digests and lookup prefixes, never plaintext API Keys.
- Active key limits, unique names, expiration, and IP allowlists are supported.
- API Key lifecycle events are recorded for auditability.

### 6.3 Programmatic Signing

- Third-party clients call public signing endpoints with `X-API-Key`.
- Message and typed-data signing requests are strictly validated.
- Arbitrary raw-hash signing is disabled to reduce misuse and accidental signing risk.
- Each signing request records user, API Key, and request digest metadata for audit purposes.

### 6.4 Programmatic Transaction Submission

- Clients submit EVM interactions through API Keys.
- The system validates network, target address, transaction data, amount, and idempotency fields.
- Idempotency controls prevent duplicate execution caused by repeated requests.
- Transaction ID, transaction hash, status, request digest, and API Key snapshot are persisted.
- Safe transaction status queries are provided without exposing calldata, internal request hashes, or sensitive identifiers.

### 6.5 Security, Risk Control, and Auditing

- Global input validation rejects unknown fields.
- Public APIs and dashboard APIs use separate authentication boundaries.
- API Keys, users, and wallets can be frozen.
- API Key lifecycle events, signing requests, transaction submissions, withdrawal policy decisions, and abnormal access are recorded.
- Basic transaction policy checks reduce high-risk calls.
- Redacted security events can be exported for monitoring integrations.

## 7. Supported Chains

SOFA ONE supports multiple EVM networks, with Base Sepolia as the default development network.

| Network | Chain ID | Type | Native Asset | Stablecoin Support |
| --- | ---: | --- | --- | --- |
| Base Sepolia | `84532` | Testnet / default development network | ETH | USDC |
| Base | `8453` | Mainnet | ETH | USDC, USDT |
| Ethereum | `1` | Mainnet | ETH | USDC, USDT |
| Ethereum Sepolia | `11155111` | Testnet | ETH | USDC |
| Polygon | `137` | Mainnet | POL | USDC, USDT |
| Polygon Amoy | `80002` | Testnet | POL | USDC |
| Arbitrum One | `42161` | Mainnet | ETH | USDC, USDT |
| OP Mainnet | `10` | Mainnet | ETH | USDC, USDT |
| OP Sepolia | `11155420` | Testnet | ETH | USDC |
| BNB Smart Chain | `56` | Mainnet | BNB | USDC, USDT |
| BNB Smart Chain Testnet | `97` | Testnet | tBNB | USDC, USDT |
| Monad | `143` | Mainnet | MON | Not configured yet |
| Monad Testnet | `10143` | Testnet | MON | Not configured yet |

These networks can be used for wallet authorization tracking, signing request validation, transaction submission, and transaction status tracking. More EVM-compatible networks can be added while keeping the same API and security model.

## 8. Access Control Model

SOFA ONE separates the user dashboard and programmatic APIs into two distinct access surfaces.

### 8.1 Public API Key Interface

Used by automation programs and third-party clients:

- Signing requests
- Transaction submission
- Transaction status queries

These interfaces only accept `X-API-Key` and do not allow direct calls from normal web sessions.

### 8.2 Dashboard Interface

Used by users to manage accounts and wallets from the web dashboard:

- Session synchronization
- Wallet binding and authorization status management
- Wallet balances, deposit information, and withdrawals
- API Key creation, revocation, rotation, and listing
- Security notification review and handling

These interfaces use user-session authentication and include additional browser-origin checks for dashboard-only operations.

## 9. Security Principles

- **Private keys never enter the application**: the business system does not store, log, return, or derive private keys.
- **Least-privilege automation**: automation programs use API Keys instead of full user sessions.
- **Separated authentication boundaries**: public API Key endpoints and dashboard endpoints belong to different trust domains.
- **Plaintext keys appear only once**: API Keys are shown to users only during creation or rotation.
- **Revocable and freezable access**: users, wallets, and API Keys can be revoked or frozen.
- **Audit by default**: critical operations leave traceable records.
- **Safe public responses**: public status endpoints do not return calldata, internal request hashes, or sensitive identifiers.

## 10. Current Status

The project already provides a runnable set of core capabilities:

- User session synchronization, wallet binding, and Agent authorization flows are defined.
- API Key creation, verification, revocation, rotation, and secure storage are implemented.
- Public signing, transaction submission, and transaction status interfaces are defined.
- Users, wallets, API Keys, signing requests, transactions, and security events are recorded and auditable.
- Basic security validation, rate limiting, and access boundaries are configured.

## 11. Project Value

SOFA ONE helps on-chain applications integrate secure automation capabilities faster:

- Reduces the risk of developers self-custodying user private keys.
- Provides a clear API Key authorization model for AI Agents and automated backends.
- Improves user visibility and control over automated on-chain actions.
- Makes signing, transactions, and key lifecycle events auditable.
- Lays the foundation for future risk controls, monitoring, policy engines, and developer SDKs.

## 12. Summary

SOFA ONE is server-side signing and transaction infrastructure for AI Agent and on-chain automation scenarios, helping developers build manageable, auditable, and programmable on-chain applications without directly handling user private keys.
