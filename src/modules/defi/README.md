# DeFi catalog and authorization

The runtime uses the static generated catalog module built from the single reviewed input, `data/defi-catalog/catalog.json`. The offline workflow is documented in [`scripts/defi-catalog/README.md`](../../../scripts/defi-catalog/README.md). Historical research and phase reports are retained as dated evidence, not as current catalog maintenance instructions.

## Authorization boundaries

- Catalog membership identifies a function; it does not grant it to an API key. `custom` mode requires exact capability IDs, and an empty custom list denies catalog capabilities. `all` mode still requires active, unpaused catalog entries and does not bypass independent permissions or safety policies.
- Profiles are metadata groupings for display and selection. They do not automatically grant, save, or expand permissions, and they do not establish complete workflows.
- Function-level DeFi execution remains separate from DeFi signing. Signing exceptions retain their own exact capability and policy checks; high-privilege DepositWallet Batch signing can authorize arbitrary well-formed calls and can transfer assets or alter permissions.
- Generic execution constraints, API-key ownership and state, pauses, session-key/EOA policies, destination protections, billing, idempotency, and simulation remain independent controls. No catalog or profile change is a reason to bypass them.
- Function grants do not impose protocol-specific financial argument limits. Callers can control ABI arguments such as assets, paths, amounts, recipients, deadlines, and payable value where the ABI permits them. Approval functions are independent capabilities; no action automatically pairs or grants an approval.
- Private keys remain within Openfort's TEE. Catalog authorization does not perform RPC/deployment verification or establish current runtime identity, balances, funding, liquidity, successful execution, or financial safety.

The dashboard's capability/profile read routes remain IAM- and frontend-guarded; grant mutations retain their existing explicit step-up-protected flow. These dashboard routes are not public API-key endpoints.
