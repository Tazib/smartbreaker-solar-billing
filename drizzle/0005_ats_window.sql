ALTER TABLE "daily_energy" ADD COLUMN "inverter_kwh" numeric(12, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "ats_start" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "ats_end" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "ats_station_id" uuid;--> statement-breakpoint
ALTER TABLE "readings" ADD COLUMN "inverter_w" double precision;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_ats_station_id_solar_stations_id_fk" FOREIGN KEY ("ats_station_id") REFERENCES "public"."solar_stations"("id") ON DELETE set null ON UPDATE no action;