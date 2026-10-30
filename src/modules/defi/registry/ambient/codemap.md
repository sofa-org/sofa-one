# Ambient cold-path registry fixture

An isolated, source-qualified fixture for one Ethereum CrocSwapDex `userCmd(uint16,bytes)` payable root, bound to the finite `ambient-coldpath-v1` scope. The scope admits only the reviewed path-1 swap payload and the enumerated path-2 LP command grammar. It does not authorize other protocol commands, arbitrary wallet children, or other Ambient deployments. The source candidate remains inactive and this fixture is not wired into production.
