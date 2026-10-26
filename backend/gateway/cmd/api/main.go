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
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/joho/godotenv"

	"github.com/finverify/api-go/internal/config"
	"github.com/finverify/api-go/internal/middleware"
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

	// A missing or weak signing key must stop the service, not quietly weaken it.
	if _, err := middleware.SigningSecret(); err != nil {
		log.Fatalf("[finverify-go] refusing to start: %v", err)
	}
	if !middleware.IsProduction() && os.Getenv("JWT_SECRET") == "" && os.Getenv("SESSION_SECRET") == "" {
		log.Printf("[WARN] JWT_SECRET is not set: using the development signing secret. Never do this in production.")
	}

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

	// Every other route the gateway answers itself needs a signed-in person whose role holds the
	// permission the Express API requires for the same path (see routes/protected.go). Everything else,
	// including the fixed addresses a wildcard route would swallow, goes to the TypeScript fallback proxy:
	// the frontend sees no change, and routes are added to Go incrementally.
	var authz *routes.Authorizer
	var protected []routes.ProtectedRoute
	if db != nil {
		authz = routes.NewAuthorizer(db)
		protected = routes.Protected(db)
	}
	routes.Mount(mux, authz, protected, tsProxy)

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

// allowedOrigins reads CORS_ORIGIN, a comma-separated list of the sites that may call this service
// from a browser.
func allowedOrigins() map[string]bool {
	origins := map[string]bool{}
	for _, origin := range strings.Split(os.Getenv("CORS_ORIGIN"), ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			origins[origin] = true
		}
	}
	return origins
}

// corsMiddleware lets the React frontend call the Go API. It also wraps each request in panic
// recovery so a handler panic returns 500 instead of crashing the entire gateway process.
// In production only the sites listed in CORS_ORIGIN are allowed; the open "any site" setting is
// kept for a developer machine where CORS_ORIGIN is not set.
func corsMiddleware(next http.Handler) http.Handler {
	origins := allowedOrigins()
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Panic recovery — keeps the gateway alive on any handler panic.
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("[finverify-go] PANIC recovered on %s %s: %v", r.Method, r.URL.Path, rec)
				http.Error(w, "internal server error", http.StatusInternalServerError)
			}
		}()

		origin := r.Header.Get("Origin")
		switch {
		case len(origins) == 0 && !middleware.IsProduction():
			w.Header().Set("Access-Control-Allow-Origin", "*")
		case origin != "" && origins[origin]:
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Client-Company-Id")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
