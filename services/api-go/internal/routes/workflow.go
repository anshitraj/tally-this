package routes

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/finverify/api-go/internal/middleware"
)

// WorkflowRun is the DB model for workflow_runs table.
type WorkflowRun struct {
	ID              string  `json:"id"`
	CompanyID       int     `json:"companyId"`
	Month           string  `json:"month"`
	Year            int     `json:"year"`
	RunType         string  `json:"runType"`
	Title           string  `json:"title"`
	Status          string  `json:"status"`
	ProgressPercent int     `json:"progressPercent"`
	CurrentStep     string  `json:"currentStep"`
	CreatedAt       string  `json:"createdAt"`
	UpdatedAt       string  `json:"updatedAt"`
	CompletedAt     *string `json:"completedAt"`
	FailedReason    *string `json:"failedReason"`
}

type RunSource struct {
	ID         int    `json:"id"`
	RunID      string `json:"runId"`
	UploadID   *int   `json:"uploadId"`
	SourceType string `json:"sourceType"`
	FileName   string `json:"fileName"`
	RowCount   *int   `json:"rowCount"`
	PageCount  *int   `json:"pageCount"`
	Status     string `json:"status"`
	CreatedAt  string `json:"createdAt"`
}

type RunArtifact struct {
	ID           int             `json:"id"`
	RunID        string          `json:"runId"`
	ArtifactType string          `json:"artifactType"`
	Title        string          `json:"title"`
	StorageKey   *string         `json:"storageKey"`
	JsonData     json.RawMessage `json:"jsonData"`
	CreatedAt    string          `json:"createdAt"`
}

type WorkflowRunDetail struct {
	WorkflowRun
	Sources   []RunSource   `json:"sources"`
	Artifacts []RunArtifact `json:"artifacts"`
}

type ActionHistoryItem struct {
	ID          int             `json:"id"`
	Action      string          `json:"action"`
	Label       string          `json:"label"`
	Description string          `json:"description"`
	ActorEmail  string          `json:"actorEmail"`
	CreatedAt   string          `json:"createdAt"`
	Metadata    json.RawMessage `json:"metadata"`
}

func normalizeRunStatus(status string) string {
	switch status {
	case "pending":
		return "queued"
	case "complete":
		return "completed"
	default:
		return status
	}
}

func clampPercent(value int) int {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func actionLabel(action string) string {
	labels := map[string]string{
		"upload.file_received":          "Uploaded file",
		"upload.metadata_received":      "Captured upload metadata",
		"upload.parsed":                 "Parsed upload",
		"upload.metadata_captured":      "Captured upload metadata",
		"upload.rows_imported":          "Imported parsed records",
		"upload.batch_import_completed": "Imported selected records",
		"reconciliation.run":            "Ran reconciliation",
		"reconciliation.approved":       "Approved reconciliation match",
		"reconciliation.rejected":       "Rejected reconciliation match",
		"gst_tds_review.generate":       "Generated GST/TDS review pack",
		"payroll.match":                 "Matched payroll payments",
		"gateway.match":                 "Matched gateway settlements",
		"report.ca_pack_export":         "Exported CA-ready pack",
	}
	if label, ok := labels[action]; ok {
		return label
	}
	return strings.Title(strings.ReplaceAll(strings.ReplaceAll(action, ".", " "), "_", " "))
}

func sourceLabel(sourceType string) string {
	labels := map[string]string{
		"bank":               "Bank Statement",
		"bank_statement":     "Bank Statement",
		"bankstatement":      "Bank Statement",
		"invoice":            "Invoices",
		"invoices":           "Invoices",
		"tally":              "Tally Export",
		"tally_export":       "Tally Export",
		"tallyexport":        "Tally Export",
		"ledger":             "Tally Export",
		"zoho":               "Zoho Export",
		"zoho_export":        "Zoho Export",
		"gst":                "GST/TDS",
		"gst_tds":            "GST/TDS",
		"gsttds":             "GST/TDS",
		"payroll":            "Payroll",
		"gateway":            "Gateway Settlement",
		"gateway_settlement": "Gateway Settlement",
		"gatewaysettlement":  "Gateway Settlement",
		"expense":            "Expenses",
		"expenses":           "Expenses",
	}
	key := strings.ToLower(strings.ReplaceAll(sourceType, "-", "_"))
	if label, ok := labels[key]; ok {
		return label
	}
	return ""
}

func metadataDescription(metadata json.RawMessage, fallback string) string {
	if len(metadata) == 0 {
		return fallback
	}
	var data map[string]any
	if err := json.Unmarshal(metadata, &data); err != nil {
		return fallback
	}
	if fileName, ok := data["fileName"].(string); ok && fileName != "" {
		if sourceType, ok := data["sourceType"].(string); ok {
			if label := sourceLabel(sourceType); label != "" {
				return fileName + " (" + label + ")"
			}
		}
		return fileName
	}
	if inserted, ok := data["inserted"].(float64); ok {
		return strconv.Itoa(int(inserted)) + " records affected"
	}
	return fallback
}

// ListWorkflowRuns returns all runs for the authenticated company.
// Note: Auth is currently delegated — company_id extracted from X-Company-ID header
// set by the TypeScript auth middleware when proxying.
func ListWorkflowRuns(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if db == nil {
			http.Error(w, `{"error":"database not configured"}`, http.StatusServiceUnavailable)
			return
		}
		auth, ok := middleware.AuthenticateRequest(db, r)
		if !ok {
			http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
			return
		}
		companyID, scoped := middleware.BooksCompany(db, w, r, auth)
		if !scoped {
			return
		}

		rows, err := db.QueryContext(r.Context(),
			`SELECT id, company_id, month, year, run_type, title, status,
			        progress_percent, COALESCE(current_step,''),
			        created_at::text, updated_at::text,
			        completed_at::text, failed_reason
			 FROM workflow_runs
			 WHERE company_id = $1
			   AND (COALESCE(metadata_json->>'clientId','') = '' OR metadata_json->>'clientId' = $1::text)
			 ORDER BY created_at DESC
			 LIMIT 50`, companyID)
		if err != nil {
			http.Error(w, `{"error":"db error"}`, http.StatusInternalServerError)
			return
		}
		defer rows.Close()

		runs := []WorkflowRun{}
		for rows.Next() {
			var run WorkflowRun
			var completedAt, failedReason sql.NullString
			if err := rows.Scan(
				&run.ID, &run.CompanyID, &run.Month, &run.Year,
				&run.RunType, &run.Title, &run.Status,
				&run.ProgressPercent, &run.CurrentStep,
				&run.CreatedAt, &run.UpdatedAt,
				&completedAt, &failedReason,
			); err != nil {
				continue
			}
			if completedAt.Valid {
				s := completedAt.String
				run.CompletedAt = &s
			}
			if failedReason.Valid {
				s := failedReason.String
				run.FailedReason = &s
			}
			run.Status = normalizeRunStatus(run.Status)
			run.ProgressPercent = clampPercent(run.ProgressPercent)
			runs = append(runs, run)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(runs)
	}
}

// GetWorkflowRun returns a run detail plus optional source/artifact rows.
func GetWorkflowRun(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if db == nil {
			http.Error(w, `{"error":"database not configured"}`, http.StatusServiceUnavailable)
			return
		}
		auth, ok := middleware.AuthenticateRequest(db, r)
		if !ok {
			http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
			return
		}
		companyID, scoped := middleware.BooksCompany(db, w, r, auth)
		if !scoped {
			return
		}

		runID := r.PathValue("id")
		if runID == "" {
			http.Error(w, `{"error":"missing run id"}`, http.StatusBadRequest)
			return
		}

		var run WorkflowRun
		var completedAt, failedReason sql.NullString
		err := db.QueryRowContext(r.Context(),
			`SELECT id, company_id, month, year, run_type, title, status,
			        progress_percent, COALESCE(current_step,''),
			        created_at::text, updated_at::text,
			        completed_at::text, failed_reason
			 FROM workflow_runs
			 WHERE id = $1 AND company_id = $2
			   AND (COALESCE(metadata_json->>'clientId','') = '' OR metadata_json->>'clientId' = $2::text)`, runID, companyID).
			Scan(&run.ID, &run.CompanyID, &run.Month, &run.Year,
				&run.RunType, &run.Title, &run.Status, &run.ProgressPercent,
				&run.CurrentStep, &run.CreatedAt, &run.UpdatedAt,
				&completedAt, &failedReason)
		if err != nil {
			http.Error(w, `{"error":"run not found"}`, http.StatusNotFound)
			return
		}
		if completedAt.Valid {
			s := completedAt.String
			run.CompletedAt = &s
		}
		if failedReason.Valid {
			s := failedReason.String
			run.FailedReason = &s
		}
		run.Status = normalizeRunStatus(run.Status)
		run.ProgressPercent = clampPercent(run.ProgressPercent)

		detail := WorkflowRunDetail{
			WorkflowRun: run,
			Sources:     listRunSources(r, db, runID),
			Artifacts:   listRunArtifacts(r, db, runID),
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(detail)
	}
}

func listRunSources(r *http.Request, db *sql.DB, runID string) []RunSource {
	rows, err := db.QueryContext(r.Context(),
		`SELECT id, run_id, upload_id, source_type, file_name, row_count, page_count, status, created_at::text
		 FROM run_sources
		 WHERE run_id = $1
		 ORDER BY created_at ASC`, runID)
	if err != nil {
		return []RunSource{}
	}
	defer rows.Close()

	sources := []RunSource{}
	for rows.Next() {
		var source RunSource
		var uploadID, rowCount, pageCount sql.NullInt64
		if err := rows.Scan(&source.ID, &source.RunID, &uploadID, &source.SourceType, &source.FileName, &rowCount, &pageCount, &source.Status, &source.CreatedAt); err != nil {
			continue
		}
		if uploadID.Valid {
			v := int(uploadID.Int64)
			source.UploadID = &v
		}
		if rowCount.Valid {
			v := int(rowCount.Int64)
			source.RowCount = &v
		}
		if pageCount.Valid {
			v := int(pageCount.Int64)
			source.PageCount = &v
		}
		sources = append(sources, source)
	}
	return sources
}

func listRunArtifacts(r *http.Request, db *sql.DB, runID string) []RunArtifact {
	rows, err := db.QueryContext(r.Context(),
		`SELECT id, run_id, artifact_type, title, storage_key, COALESCE(json_data::text, '{}'), created_at::text
		 FROM run_artifacts
		 WHERE run_id = $1
		 ORDER BY created_at ASC`, runID)
	if err != nil {
		return []RunArtifact{}
	}
	defer rows.Close()

	artifacts := []RunArtifact{}
	for rows.Next() {
		var artifact RunArtifact
		var storageKey sql.NullString
		var jsonText string
		if err := rows.Scan(&artifact.ID, &artifact.RunID, &artifact.ArtifactType, &artifact.Title, &storageKey, &jsonText, &artifact.CreatedAt); err != nil {
			continue
		}
		if storageKey.Valid {
			s := storageKey.String
			artifact.StorageKey = &s
		}
		artifact.JsonData = json.RawMessage(jsonText)
		artifacts = append(artifacts, artifact)
	}
	return artifacts
}

// GetWorkflowRunProgress returns progress for a specific run.
func GetWorkflowRunProgress(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if db == nil {
			http.Error(w, `{"error":"database not configured"}`, http.StatusServiceUnavailable)
			return
		}
		auth, ok := middleware.AuthenticateRequest(db, r)
		if !ok {
			http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
			return
		}
		companyID, scoped := middleware.BooksCompany(db, w, r, auth)
		if !scoped {
			return
		}

		// Extract :id from path /api/workflow/runs/{id}/progress
		parts := strings.Split(r.URL.Path, "/")
		runID := ""
		for i, p := range parts {
			if p == "runs" && i+1 < len(parts) {
				runID = parts[i+1]
				break
			}
		}
		if runID == "" {
			http.Error(w, `{"error":"missing run id"}`, http.StatusBadRequest)
			return
		}

		var run WorkflowRun
		var stepsJSON sql.NullString
		var completedAt, failedReason sql.NullString
		err := db.QueryRowContext(r.Context(),
			`SELECT id, status, progress_percent, COALESCE(current_step,''),
			        steps_json::text, completed_at::text, failed_reason
			 FROM workflow_runs WHERE id = $1 AND company_id = $2
			   AND (COALESCE(metadata_json->>'clientId','') = '' OR metadata_json->>'clientId' = $2::text)`, runID, companyID).
			Scan(&run.ID, &run.Status, &run.ProgressPercent, &run.CurrentStep,
				&stepsJSON, &completedAt, &failedReason)

		if err != nil {
			http.Error(w, `{"error":"run not found"}`, http.StatusNotFound)
			return
		}

		type progressResp struct {
			RunID           string          `json:"runId"`
			Status          string          `json:"status"`
			ProgressPercent int             `json:"progressPercent"`
			CurrentStep     string          `json:"currentStep"`
			Steps           json.RawMessage `json:"steps"`
			CompletedAt     *string         `json:"completedAt"`
			FailedReason    *string         `json:"failedReason"`
		}

		resp := progressResp{
			RunID:           run.ID,
			Status:          normalizeRunStatus(run.Status),
			ProgressPercent: clampPercent(run.ProgressPercent),
			CurrentStep:     run.CurrentStep,
			Steps:           json.RawMessage("[]"),
		}
		if stepsJSON.Valid && stepsJSON.String != "" {
			resp.Steps = json.RawMessage(stepsJSON.String)
		}
		if completedAt.Valid {
			s := completedAt.String
			resp.CompletedAt = &s
		}
		if failedReason.Valid {
			s := failedReason.String
			resp.FailedReason = &s
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}
}

// ListActionHistory returns workflow action history in the same shape the React
// ActionHistory component consumes. It prefers action_history when present, then
// falls back to audit_logs for current deployments.
func ListActionHistory(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if db == nil {
			http.Error(w, `{"error":"database not configured"}`, http.StatusServiceUnavailable)
			return
		}
		auth, ok := middleware.AuthenticateRequest(db, r)
		if !ok {
			http.Error(w, `{"error":"unauthenticated"}`, http.StatusUnauthorized)
			return
		}
		companyID, scoped := middleware.BooksCompany(db, w, r, auth)
		if !scoped {
			return
		}

		limit := 30
		if raw := r.URL.Query().Get("limit"); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
				limit = parsed
			}
		}
		if limit > 100 {
			limit = 100
		}

		items := listDedicatedActionHistory(r, db, companyID, limit)
		if len(items) == 0 {
			items = listAuditLogActionHistory(r, db, companyID, limit)
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(items)
	}
}

func listDedicatedActionHistory(r *http.Request, db *sql.DB, companyID int, limit int) []ActionHistoryItem {
	rows, err := db.QueryContext(r.Context(),
		`SELECT id, action, message, COALESCE(status, 'success'), COALESCE(metadata_json::text, '{}'), created_at::text
		 FROM action_history
		 WHERE company_id = $1
		 ORDER BY created_at DESC
		 LIMIT $2`, companyID, limit)
	if err != nil {
		return []ActionHistoryItem{}
	}
	defer rows.Close()

	items := []ActionHistoryItem{}
	for rows.Next() {
		var item ActionHistoryItem
		var message, status, metadataText string
		if err := rows.Scan(&item.ID, &item.Action, &message, &status, &metadataText, &item.CreatedAt); err != nil {
			continue
		}
		item.Label = actionLabel(item.Action)
		item.Description = message
		item.ActorEmail = "system"
		item.Metadata = json.RawMessage(metadataText)
		items = append(items, item)
	}
	return items
}

func listAuditLogActionHistory(r *http.Request, db *sql.DB, companyID int, limit int) []ActionHistoryItem {
	rows, err := db.QueryContext(r.Context(),
		`SELECT id, action, entity_type, COALESCE(actor_email, 'system'), COALESCE(metadata::text, '{}'), created_at::text
		 FROM audit_logs
		 WHERE company_id = $1
		 ORDER BY created_at DESC
		 LIMIT $2`, companyID, limit)
	if err != nil {
		return []ActionHistoryItem{}
	}
	defer rows.Close()

	items := []ActionHistoryItem{}
	for rows.Next() {
		var item ActionHistoryItem
		var entityType, metadataText string
		if err := rows.Scan(&item.ID, &item.Action, &entityType, &item.ActorEmail, &metadataText, &item.CreatedAt); err != nil {
			continue
		}
		item.Label = actionLabel(item.Action)
		item.Metadata = json.RawMessage(metadataText)
		item.Description = metadataDescription(item.Metadata, entityType)
		items = append(items, item)
	}
	return items
}
