# Deployment notes

This migration drops the unused `step_up_challenges.challenge_code_hash` and `attempts`
columns. It is **not safe for a mixed-version deployment**: before migration, the old
schema requires `challenge_code_hash` on every insert, so the new application cannot
write proofs. After migration, the old generated Prisma Client/schema expects the
dropped columns and cannot safely operate against the new schema.

Use a maintenance window and take/verify a database backup before proceeding:

1. Stop all old application instances, including any workers, so none can access the
   database during the schema transition.
2. Using the deployment package containing the new Prisma schema, run the existing
   `prisma:migrate:deploy` command.
3. Start only application instances built with the matching new schema and generated
   Prisma Client.
4. Verify MFA proof issuance/validation and both TOTP and recovery-code MFA disable
   flows before ending the maintenance window.

This procedure is documentation only; no database migration has been executed here.
Zero-downtime rollout requires a separate expand-contract migration plan and is not
provided by this migration.
