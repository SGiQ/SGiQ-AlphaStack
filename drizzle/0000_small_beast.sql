CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');--> statement-breakpoint
CREATE TYPE "public"."position_status" AS ENUM('open', 'closed', 'stopped');--> statement-breakpoint
CREATE TYPE "public"."run_mode" AS ENUM('paper', 'live');--> statement-breakpoint
CREATE TYPE "public"."order_side" AS ENUM('buy', 'sell');--> statement-breakpoint
CREATE TYPE "public"."strategy_kind" AS ENUM('momentum_breakout', 'mean_reversion', 'trend_following', 'alt_speculation');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"signal_id" uuid,
	"intent" jsonb NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "drawdown_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"year_month" text NOT NULL,
	"peak_equity" numeric(18, 8) NOT NULL,
	"current_equity" numeric(18, 8) NOT NULL,
	"drawdown_pct" numeric(6, 4) NOT NULL,
	"kill_switch_tripped" boolean DEFAULT false NOT NULL,
	"tripped_at" timestamp with time zone,
	"reset_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"signal_id" uuid,
	"strategy_id" integer NOT NULL,
	"broker_order_id" text,
	"client_order_id" text NOT NULL,
	"symbol" text NOT NULL,
	"side" "order_side" NOT NULL,
	"notional" numeric(18, 8),
	"qty" numeric(24, 12),
	"filled_avg_price" numeric(18, 8),
	"status" text NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "performance_by_strategy" (
	"id" serial PRIMARY KEY NOT NULL,
	"year_month" text NOT NULL,
	"strategy_id" integer NOT NULL,
	"pnl" numeric(18, 8) DEFAULT '0' NOT NULL,
	"trade_count" integer DEFAULT 0 NOT NULL,
	"win_count" integer DEFAULT 0 NOT NULL,
	"loss_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"qty" numeric(24, 12) NOT NULL,
	"avg_cost" numeric(18, 8) NOT NULL,
	"stop_loss" numeric(18, 8),
	"take_profit" numeric(18, 8),
	"status" "position_status" DEFAULT 'open' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"realised_pnl" numeric(18, 8)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "run_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"mode" "run_mode" NOT NULL,
	"summary" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"strategy_id" integer NOT NULL,
	"symbol" text NOT NULL,
	"side" "order_side" NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"suggested_notional" numeric(18, 8),
	"suggested_qty" numeric(24, 12),
	"stop_loss" numeric(18, 8),
	"take_profit" numeric(18, 8),
	"reason" text NOT NULL,
	"executed_order_id" uuid,
	"skipped_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "strategies" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" "strategy_kind" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"weight" numeric(5, 4) DEFAULT '0.0000' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_id_run_logs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_logs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_run_id_run_logs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_logs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "orders" ADD CONSTRAINT "orders_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "performance_by_strategy" ADD CONSTRAINT "performance_by_strategy_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "positions" ADD CONSTRAINT "positions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signals" ADD CONSTRAINT "signals_run_id_run_logs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."run_logs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "approvals_status_idx" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "drawdown_ym_idx" ON "drawdown_state" USING btree ("year_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_run_idx" ON "orders" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "orders_client_idx" ON "orders" USING btree ("client_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "perf_ym_strategy_idx" ON "performance_by_strategy" USING btree ("year_month","strategy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_symbol_idx" ON "positions" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_strategy_idx" ON "positions" USING btree ("strategy_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "positions_status_idx" ON "positions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signals_run_idx" ON "signals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signals_strategy_idx" ON "signals" USING btree ("strategy_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "strategies_name_idx" ON "strategies" USING btree ("name");