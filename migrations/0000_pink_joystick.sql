CREATE TABLE "stripe_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"stripe_event_id" text NOT NULL,
	"stripe_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stripe_webhook_events_stripe_event_id_unique" UNIQUE("stripe_event_id")
);