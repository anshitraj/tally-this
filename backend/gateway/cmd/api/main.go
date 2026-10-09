// FinVerify OS — Go API Gateway
//
// Phase 1: health + workflow_runs endpoints; all other routes proxied to TypeScript fallback.
// Phase 2+: progressively migrate routes as Python worker parity tests pass.
package main

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"

	"github.com/finverify/api-go/internal/config"
	"github.com/finverify/api-go/internal/proxy"
	"github.com/finverify/api-go/internal/routes"
)

func main() {
	// Load .env from repo root
	for _, p := range []string{"../../.env", "../../../.env", ".env"} {
		abs, _ := filepath.Abs(p)
		if _, err := os.Stat(abs); err == nil {
			_ = godotenv.Load(abs)
			break
		}
	}

	cfg := config.Load()

	// Connect to Postgres
	var db *sql.DB
	if cfg.DatabaseURL != "" {
		var err error
		db, err = sql.Open("pgx", cfg.DatabaseURL)
		if err != nil {
			log.Printf("[WARN] DB connection failed: %v — workflow routes will return errors", err)
		}
	}

	// Fallback proxy to TypeScript API
	tsProxy := proxy.New(cfg.TypeScriptAPIURL)

	mux := http.NewServeMux()

	// ── Implemented in Go ───────────────────────────────────────────────────

	// Health — shows all service statuses
	mux.HandleFunc("GET /api/health", routes.HealthHandler(cfg, db))
	mux.HandleFunc("GET /api/healthz", routes.HealthHandler(cfg, db))

	// Workflow runs
	if db != nil {
		mux.HandleFunc("GET /api/workflow/runs", routes.ListWorkflowRuns(db))
		mux.HandleFunc("GET /api/workflow/runs/{id}", routes.GetWorkflowRun(db))
		mux.HandleFunc("GET /api/workflow/runs/{id}/progress", routes.GetWorkflowRunProgress(db))
		mux.HandleFunc("GET /api/action-history", routes.ListActionHistory(db))

		// Upload import orchestration
		mux.HandleFunc("POST /api/uploads/import-selected-sources", routes.ImportSelectedSources(db))
		mux.HandleFunc("POST /api/uploads/import-all-parsed", routes.ImportAllParsed(db))

		// Reconciliation ownership
		mux.HandleFunc("GET /api/reconciliation/runs", routes.ListReconciliationFolders(db))
		mux.HandleFunc("GET /api/reconciliation", routes.ListReconciliationMatches(db))
		mux.HandleFunc("POST /api/reconciliation/preflight", routes.ReconciliationPreflight(db))
		mux.HandleFunc("POST /api/reconciliation/run", routes.RunReconciliation(db))
		mux.HandleFunc("GET /api/reconciliation/run", routes.RunReconciliation(db))
		mux.HandleFunc("POST /api/reconciliation/{id}/approve", routes.UpdateReconciliationMatch(db, "approved"))
		mux.HandleFunc("POST /api/reconciliation/{id}/reject", routes.UpdateReconciliationMatch(db, "rejected"))
		mux.HandleFunc("POST /api/reconciliation/{id}/needs-info", routes.UpdateReconciliationMatch(db, "needs_info"))
		mux.HandleFunc("POST /api/reconciliation/{id}/send-to-ca", routes.SendMatchToCA(db))
	}

	// ── Everything else → TypeScript fallback proxy ─────────────────────────
	// Frontend sees no change; routes are added to Go incrementally.
	mux.Handle("/", tsProxy)

	addr := ":" + cfg.GoAPIPort
	log.Printf("[finverify-go] Listening on %s  (TypeScript fallback: %s, Python worker: %s)",
		addr, cfg.TypeScriptAPIURL, cfg.PythonWorkerURL)

	for {
		err := http.ListenAndServe(addr, corsMiddleware(mux))
		// ErrServerClosed means a graceful shutdown — exit cleanly.
		if err == http.ErrServerClosed {
			log.Printf("[finverify-go] Server closed gracefully.")
			return
		}
		// Any other error (e.g. transient port issue) — log and retry.
		log.Printf("[finverify-go] Server error: %v — restarting in 1s...", err)
		time.Sleep(1 * time.Second)
	}
}

// corsMiddleware allows the React frontend to call the Go API.
// It also wraps each request in panic recovery so a handler panic
// returns 500 instead of crashing the entire gateway process.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Panic recovery — keeps the gateway alive on any handler panic.
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[finverify-go] PANIC recovered on %s %s: %v", r.Method, r.URL.Path, rec)
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()

		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
