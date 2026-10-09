package routes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/finverify/api-go/internal/config"
)

type healthResponse struct {
	OK                 bool           `json:"ok"`
	GoAPI              string         `json:"goApi"`
	TypeScriptFallback string         `json:"typeScriptFallback"`
	PythonWorker       string         `json:"pythonWorker"`
	Database           string         `json:"database"`
	LatencyMs          map[string]int `json:"latencyMs"`
	AIProviders        struct {
		Gemini string `json:"gemini"`
	} `json:"aiProviders"`
}

// HealthHandler returns aggregate health of all services.
func HealthHandler(cfg *config.Config, db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()

		resp := healthResponse{
			OK:        true,
			GoAPI:     "ok",
			LatencyMs: map[string]int{},
		}

		// Check TypeScript fallback
		tsStatus, tsMs := pingServiceWithLatency(ctx, cfg.TypeScriptAPIURL+"/api/health")
		resp.TypeScriptFallback = tsStatus
		resp.LatencyMs["typescript"] = tsMs

		// Check Python worker
		pyStatus, pyMs := pingServiceWithLatency(ctx, cfg.PythonWorkerURL+"/health")
		resp.PythonWorker = pyStatus
		resp.LatencyMs["python"] = pyMs

		// Check DB directly
		if db != nil {
			t0 := time.Now()
			dbCtx, dbCancel := context.WithTimeout(ctx, 5*time.Second)
			defer dbCancel()
			if err := db.PingContext(dbCtx); err != nil {
				resp.Database = "error: " + err.Error()[:min(len(err.Error()), 50)]
			} else {
				resp.Database = "ok"
				resp.LatencyMs["database"] = int(time.Since(t0).Milliseconds())
			}
		} else {
			resp.Database = "not-configured"
		}

		if resp.TypeScriptFallback == "unreachable" || resp.PythonWorker == "unreachable" {
			resp.OK = false
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

func pingServiceWithLatency(ctx context.Context, url string) (string, int) {
	t0 := time.Now()
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	ms := int(time.Since(t0).Milliseconds())
	if err != nil {
		return "unreachable", ms
	}
	defer resp.Body.Close()
	if resp.StatusCode == 200 {
		return "ok", ms
	}
	return "degraded", ms
}

// pingService kept for backward compat
func pingService(ctx context.Context, url string) (string, error) {
	s, _ := pingServiceWithLatency(ctx, url)
	if s == "unreachable" {
		return "", fmt.Errorf("unreachable")
	}
	return s, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
