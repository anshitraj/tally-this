-- E-commerce reconciliation: marketplace report imports, the transactions read from them, exceptions, reports and the
-- trail of human decisions. Only adds tables and indexes; safe to run more than once.

CREATE TABLE IF NOT EXISTS "marketplace_import_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"marketplace" text NOT NULL,
	"seller_gstin" text,
	"financial_year" text,
	"period" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"stage" text DEFAULT 'queued' NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"message" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
CREATE INDEX IF NOT EXISTS "idx_marketplace_import_jobs_company" ON "marketplace_import_jobs" ("company_id", "marketplace", "created_at");

CREATE TABLE IF NOT EXISTS "marketplace_source_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"company_id" integer NOT NULL,
	"marketplace" text NOT NULL,
	"file_name" text NOT NULL,
	"container_name" text,
	"sheet_name" text,
	"sha256" text NOT NULL,
	"size_bytes" integer DEFAULT 0 NOT NULL,
	"report_type" text NOT NULL,
	"status" text NOT NULL,
	"headers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"column_map" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"unknown_columns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"periods" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message" text,
	"storage_provider" text,
	"storage_bucket" text,
	"storage_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_marketplace_source_files_job" ON "marketplace_source_files" ("job_id");
CREATE INDEX IF NOT EXISTS "idx_marketplace_source_files_company_sha" ON "marketplace_source_files" ("company_id", "marketplace", "sha256");

CREATE TABLE IF NOT EXISTS "marketplace_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"marketplace" text NOT NULL,
	"job_id" text NOT NULL,
	"source_file_id" integer NOT NULL,
	"source_row" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"duplicate_of" integer,
	"seller_gstin" text,
	"order_id" text,
	"sub_order_id" text,
	"line_id" text,
	"event_type" text NOT NULL,
	"order_date" date,
	"document_date" date,
	"return_date" date,
	"document_number" text,
	"report_period" text NOT NULL,
	"financial_year" text,
	"hsn" text,
	"description" text,
	"quantity" numeric(14, 3),
	"uqc" text,
	"taxable_value" numeric(16, 2) DEFAULT '0' NOT NULL,
	"gst_rate" numeric(6, 3),
	"igst" numeric(16, 2) DEFAULT '0' NOT NULL,
	"cgst" numeric(16, 2) DEFAULT '0' NOT NULL,
	"sgst" numeric(16, 2) DEFAULT '0' NOT NULL,
	"cess" numeric(16, 2) DEFAULT '0' NOT NULL,
	"invoice_value" numeric(16, 2) DEFAULT '0' NOT NULL,
	"source_tax" numeric(16, 2),
	"computed_tax" numeric(16, 2),
	"shipping_taxable" numeric(16, 2),
	"place_of_supply" text,
	"supply_type" text DEFAULT 'unknown' NOT NULL,
	"customer_type" text DEFAULT 'B2C' NOT NULL,
	"eco_gstin" text,
	"source_status" text,
	"recon_status" text DEFAULT 'unreviewed' NOT NULL,
	"related_event_id" integer,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_marketplace_events_period" ON "marketplace_events" ("company_id", "marketplace", "report_period");
CREATE INDEX IF NOT EXISTS "idx_marketplace_events_key" ON "marketplace_events" ("company_id", "marketplace", "idempotency_key");
CREATE INDEX IF NOT EXISTS "idx_marketplace_events_sub_order" ON "marketplace_events" ("company_id", "marketplace", "sub_order_id");
CREATE INDEX IF NOT EXISTS "idx_marketplace_events_job" ON "marketplace_events" ("job_id");

CREATE TABLE IF NOT EXISTS "marketplace_exceptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"marketplace" text NOT NULL,
	"job_id" text NOT NULL,
	"event_id" integer,
	"period" text,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"note" text,
	"resolved_by" integer,
	"resolved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_marketplace_exceptions_period" ON "marketplace_exceptions" ("company_id", "marketplace", "period", "status");
CREATE INDEX IF NOT EXISTS "idx_marketplace_exceptions_event" ON "marketplace_exceptions" ("event_id");

CREATE TABLE IF NOT EXISTS "marketplace_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"marketplace" text NOT NULL,
	"period" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"data_version" text,
	"approved_by" integer,
	"approved_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_marketplace_reports_period" ON "marketplace_reports" ("company_id", "marketplace", "period");

CREATE TABLE IF NOT EXISTS "marketplace_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer NOT NULL,
	"marketplace" text NOT NULL,
	"event_id" integer,
	"exception_id" integer,
	"report_id" integer,
	"action" text NOT NULL,
	"note" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" integer,
	"actor_email" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "idx_marketplace_reviews_event" ON "marketplace_reviews" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_marketplace_reviews_report" ON "marketplace_reviews" ("report_id");
