-- Add immutable attribution snapshots for API-key initiated signing requests.
ALTER TABLE "signing_requests"
ADD COLUMN "auth_method" VARCHAR(20) NOT NULL DEFAULT 'api_key',
ADD COLUMN "api_key_prefix" VARCHAR(12),
ADD COLUMN "api_key_name" VARCHAR(100);

-- Keep signing audit values constrained to the application-supported state machine.
ALTER TABLE "signing_requests"
ADD CONSTRAINT "signing_requests_type_check" CHECK ("type" IN ('message', 'typed_data')),
ADD CONSTRAINT "signing_requests_status_check" CHECK ("status" IN ('submitting', 'signed', 'failed')),
ADD CONSTRAINT "signing_requests_auth_method_check" CHECK ("auth_method" IN ('api_key'));
