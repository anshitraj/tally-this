package routes

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

func runTitle(runType string) string {
	titles := map[string]string{
		"import_records":              "Import records",
		"bank_tally_reconciliation":   "Bank and ledger reconciliation",
		"bank_invoice_reconciliation": "Bank and invoice reconciliation",
		"bank_gateway_reconciliation": "Bank and gateway reconciliation",
		"bank_payroll_reconciliation": "Bank and payroll reconciliation",
		"gst_tds_review":              "GST/TDS review",
		"full_month_close":            "Full month close",
	}
	if title, ok := titles[runType]; ok {
		return title
	}
	return "Workflow run"
}

func currentMonthYear() (string, int) {
	now := time.Now()
	return now.Format("2006-01"), now.Year()
}

func createWorkflowRun(ctx context.Context, db *sql.DB, companyID int, runType string, userID *int, metadata map[string]any) (string, error) {
	month, year := currentMonthYear()
	metadataJSON, _ := json.Marshal(metadata)
	var userIDValue any = nil
	if userID != nil {
		userIDValue = *userID
	}

	var runID string
	err := db.QueryRowContext(ctx,
		`INSERT INTO workflow_runs
			(company_id, month, year, run_type, title, status, progress_percent, current_step, created_by, metadata_json)
		 VALUES ($1, $2, $3, $4, $5, 'running', 5, $6, $7, $8::jsonb)
		 RETURNING id`,
		companyID, month, year, runType, runTitle(runType), "Starting", userIDValue, string(metadataJSON),
	).Scan(&runID)
	return runID, err
}

func advanceWorkflowRun(ctx context.Context, db *sql.DB, runID string, percent int, step string) {
	_, _ = db.ExecContext(ctx,
		`UPDATE workflow_runs
		 SET status = 'running', progress_percent = $2, current_step = $3
		 WHERE id = $1`,
		runID, clampPercent(percent), step)
}

func finishWorkflowRun(ctx context.Context, db *sql.DB, runID string, status string, failedReason *string) {
	if status == "" {
		status = "completed"
	}
	percent := 100
	if status == "failed" {
		percent = 0
	}
	_, _ = db.ExecContext(ctx,
		`UPDATE workflow_runs
		 SET status = $2, progress_percent = $3, current_step = $4, completed_at = CASE WHEN $2 = 'completed' THEN NOW() ELSE completed_at END, failed_reason = $5
		 WHERE id = $1`,
		runID, status, percent, status, failedReason)
}

func saveRunArtifact(ctx context.Context, db *sql.DB, runID string, artifactType string, title string, data map[string]any) {
	payload, _ := json.Marshal(data)
	_, _ = db.ExecContext(ctx,
		`INSERT INTO run_artifacts (run_id, artifact_type, title, json_data)
		 VALUES ($1, $2, $3, $4::jsonb)`,
		runID, artifactType, title, string(payload))
}

func addRunSource(ctx context.Context, db *sql.DB, runID string, uploadID int, sourceType string, fileName string, rowCount int, status string) {
	_, _ = db.ExecContext(ctx,
		`INSERT INTO run_sources (run_id, upload_id, source_type, file_name, row_count, status)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		runID, uploadID, sourceType, fileName, rowCount, status)
}

func writeActionHistory(ctx context.Context, db *sql.DB, companyID int, runID *string, userID *int, action string, message string, status string, metadata map[string]any) {
	month, year := currentMonthYear()
	payload, _ := json.Marshal(metadata)
	var runValue any = nil
	if runID != nil {
		runValue = *runID
	}
	var userValue any = nil
	if userID != nil {
		userValue = *userID
	}
	if status == "" {
		status = "success"
	}
	_, _ = db.ExecContext(ctx,
		`INSERT INTO action_history (company_id, month, year, run_id, user_id, action, message, status, metadata_json)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
		companyID, month, year, runValue, userValue, action, message, status, string(payload))
}

func writeAuditLog(ctx context.Context, db *sql.DB, companyID int, userID *int, actorEmail string, action string, entityType string, entityID any, metadata map[string]any, ipAddress string) {
	payload, _ := json.Marshal(metadata)
	var userValue any = nil
	if userID != nil {
		userValue = *userID
	}
	if actorEmail == "" {
		actorEmail = "system@finverify.local"
	}
	_, _ = db.ExecContext(ctx,
		`INSERT INTO audit_logs (company_id, user_id, actor_email, action, entity_type, entity_id, metadata, ip_address)
		 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
		companyID, userValue, actorEmail, action, entityType, entityID, string(payload), ipAddress)
}

func errorJSON(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"error":%q}`, message)
}
