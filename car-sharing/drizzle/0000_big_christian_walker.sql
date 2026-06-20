CREATE TABLE "vehicles" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"available" boolean NOT NULL,
	"status" text NOT NULL,
	"lat" double precision,
	"lng" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
