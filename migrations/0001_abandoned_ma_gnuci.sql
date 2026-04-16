CREATE TABLE "auth_email_throttle" (
	"id" serial PRIMARY KEY NOT NULL,
	"email_hash" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gifts" ADD COLUMN "sender_email_hash" text;