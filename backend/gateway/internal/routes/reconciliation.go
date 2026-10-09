package routes

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/finverify/api-go/internal/middleware"
)

type bankTxn struct {
	ID              int
	Date            string
	Narration       string
	Amount          float64
	Type            string
	Source          string
	BankName        *string
	Reference       *string
	Status          string
	ConfidenceScore int
	MatchedInvoice  *int
	Note            *string
	SourceUploadID  *int
}

type invoiceRow struct {
	ID             int
	InvoiceNumber  string
	VendorName     string
	CustomerName   *string
	GSTIN          *string
	Date           string
	Amount         float64
	GSTAmount      *float64
	Type           string
	PaymentStatus  string
	Status         string
	LinkedTxnID    *int
	SourceUploadID *int
}

type ledgerRow struct {
	ID             int
	Date           string
	LedgerName     string
	VoucherNumber  *string
	Amount         float64
	DebitCredit    string
	SourceUploadID *int
}

type payrollRow struct {
	ID            int
	EmployeeName  string
	Month         string
	NetAmount     float64
	PaymentDate   *string
	BankReference *string
	Status        string
}

type gatewayRow struct {
	ID             int
	Provider       string
	SettlementID   string
	GrossAmount    float64
	Fees           float64
	GSTOnFees      *float64
	NetAmount      float64
	SettlementDate string
	BankReference  *string
	Status         string
}

type suggestion struct {
	BankTransactionID *int
	InvoiceID         *int
	LedgerEntryID     *int
	MatchType         string
	ConfidenceScore   int
	Reason            string
	Status            string
	SourceUploadIDs   []int
}

type reconciliationFolder struct {
	RunID       string   `json:"runId"`
	Name        string   `json:"name"`
	Title       string   `json:"title"`
	RunType     string   `json:"runType"`
	Status      string   `json:"status"`
	CreatedAt   string   `json:"createdAt"`
	CompletedAt *string  `json:"completedAt"`
	MatchCount  int      `json:"matchCount"`
	SourceFiles []string `json:"sourceFiles"`
	SourceTypes []string `json:"sourceTypes"`
}

func ListReconciliationFolders(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.AuthenticateRequest(db, r)
		if !ok {
			errorJSON(w, http.StatusUnauthorized, "unauthenticated")
			return
		}
		companyID, scoped := middleware.BooksCompany(db, w, r, auth)
		if !scoped {
			return
		}
		folders, err := loadReconciliationFolders(r, db, companyID)
		if err != nil {
			errorJSON(w, http.StatusInternalServerError, "could not load reconciliation folders")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(folders)
	}
}

func ListReconciliationMatches(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.AuthenticateRequest(db, r)
		if !ok {
			errorJSON(w, http.StatusUnauthorized, "unauthenticated")
			return
		}
		companyID, scoped := middleware.BooksCompany(db, w, r, auth)
		if !scoped {
			return
		}
		items, err := loadReconciliationMatches(r, db, companyID, r.URL.Query().Get("status"), r.URL.Query().Get("runId"))
		if err != nil {
			errorJSON(w, http.StatusInternalServerError, "could not load reconciliation matches")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(items)
	}
}

func ReconciliationPreflight(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.AuthenticateRequest(db, r)
		if !ok {
			errorJSON(w, http.StatusUnauthorized, "unauthenticated")
			return
		}
		companyID, scoped := middleware.BooksCompany(db, w, r, auth)
		if !scoped {
			return
		}
		var body struct {
			RecipeID string `json:"recipeId"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.RecipeID == "" {
			body.RecipeID = "FULL_MONTH_CLOSE"
		}
		counts := map[string]int{
			"bankTransactions":          countRows(r, db, "bank_transactions", companyID, ""),
			"invoices":                  countRows(r, db, "invoices", companyID, ""),
			"acceptedInvoices":          countRows(r, db, "invoices", companyID, "status = 'pending_reconciliation'"),
			"ledgerEntries":             countRows(r, db, "ledger_entries", companyID, ""),
			"payrollEntries":            countRows(r, db, "payroll_entries", companyID, ""),
			"gatewaySettlements":        countRows(r, db, "gateway_settlements", companyID, ""),
			"gstRecords":                countRows(r, db, "gst_records", companyID, ""),
			"pendingInvoiceExtractions": countRows(r, db, "ai_extractions", companyID, "status = 'extracted_pending_review'"),
		}

		blockers := []string{}
		warnings := []string{}
		recipeID := body.RecipeID
		if recipeID == "GST_TDS_REVIEW" {
			if counts["gstRecords"] == 0 {
				blockers = append(blockers, "No GST/TDS records imported. Import GST/TDS data first.")
			}
		} else if recipeID == "BANK_TALLY_RECONCILIATION" {
			if counts["bankTransactions"] == 0 {
				blockers = append(blockers, "No bank transactions imported. Upload and import a bank statement first.")
			}
			if counts["ledgerEntries"] == 0 {
				blockers = append(blockers, "No ledger entries imported. Upload and import a Tally or Zoho export first.")
			}
		} else if recipeID == "BANK_INVOICE_RECONCILIATION" {
			if counts["bankTransactions"] == 0 {
				blockers = append(blockers, "No bank transactions imported. Upload and import a bank statement first.")
			}
			if counts["acceptedInvoices"] == 0 {
				blockers = append(blockers, "No accepted invoice records found. Import invoices or accept AI extracted invoice results first.")
			}
		} else if recipeID == "BANK_GATEWAY_RECONCILIATION" {
			if counts["bankTransactions"] == 0 {
				blockers = append(blockers, "No bank transactions imported. Upload and import a bank statement first.")
			}
			if counts["gatewaySettlements"] == 0 {
				blockers = append(blockers, "No gateway settlements imported. Upload and import a gateway settlement export first.")
			}
		} else if recipeID == "BANK_PAYROLL_RECONCILIATION" {
			if counts["bankTransactions"] == 0 {
				blockers = append(blockers, "No bank transactions imported. Upload and import a bank statement first.")
			}
			if counts["payrollEntries"] == 0 {
				blockers = append(blockers, "No payroll entries imported. Upload and import payroll records first.")
			}
		} else {
			if counts["bankTransactions"] == 0 {
				blockers = append(blockers, "No bank transactions imported. Upload and import a bank statement first.")
			}
			if counts["invoices"] == 0 && counts["ledgerEntries"] == 0 {
				blockers = append(blockers, "No invoices or ledger entries found. Import invoice or Tally/Zoho files first.")
			}
		}
		if counts["pendingInvoiceExtractions"] > 0 {
			warnings = append(warnings, fmt.Sprintf("%d invoice extraction(s) are pending review. Consider reviewing before reconciliation.", counts["pendingInvoiceExtractions"]))
		}
		if recipeID == "FULL_MONTH_CLOSE" && counts["gstRecords"] == 0 {
			warnings = append(warnings, "No GST/TDS records imported. GST/TDS review will be skipped.")
		}
		if recipeID == "FULL_MONTH_CLOSE" && counts["payrollEntries"] == 0 {
			warnings = append(warnings, "No payroll entries imported. Payroll matching will be skipped.")
		}
		if recipeID == "FULL_MONTH_CLOSE" && counts["gatewaySettlements"] == 0 {
			warnings = append(warnings, "No gateway settlements imported. Gateway matching will be skipped.")
		}

		optionAllowed := func(ids ...string) bool {
			for _, id := range ids {
				if id == recipeID {
					return true
				}
			}
			return false
		}
		estimated := "/app/reconciliation"
		if recipeID == "BANK_TALLY_RECONCILIATION" {
			estimated = "/app/ledger-match"
		} else if recipeID == "BANK_GATEWAY_RECONCILIATION" {
			estimated = "/app/gateway-settlements"
		} else if recipeID == "BANK_PAYROLL_RECONCILIATION" {
			estimated = "/app/payroll"
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"canRun":           len(blockers) == 0,
			"blockers":         blockers,
			"warnings":         warnings,
			"availableSources": counts,
			"counts":           counts,
			"matchingOptions": []map[string]any{
				{"id": "bank_to_invoices", "label": "Bank transactions to invoices", "enabled": counts["bankTransactions"] > 0 && counts["invoices"] > 0 && optionAllowed("BANK_INVOICE_RECONCILIATION", "FULL_MONTH_CLOSE"), "defaultChecked": optionAllowed("BANK_INVOICE_RECONCILIATION", "FULL_MONTH_CLOSE")},
				{"id": "bank_to_ledger", "label": "Bank transactions to ledger entries", "enabled": counts["bankTransactions"] > 0 && counts["ledgerEntries"] > 0 && optionAllowed("BANK_TALLY_RECONCILIATION", "FULL_MONTH_CLOSE"), "defaultChecked": optionAllowed("BANK_TALLY_RECONCILIATION", "FULL_MONTH_CLOSE")},
				{"id": "bank_to_payroll", "label": "Bank transactions to payroll", "enabled": counts["bankTransactions"] > 0 && counts["payrollEntries"] > 0 && optionAllowed("BANK_PAYROLL_RECONCILIATION", "FULL_MONTH_CLOSE"), "defaultChecked": recipeID == "BANK_PAYROLL_RECONCILIATION"},
				{"id": "bank_to_gateway", "label": "Bank credits to gateway settlements", "enabled": counts["bankTransactions"] > 0 && counts["gatewaySettlements"] > 0 && optionAllowed("BANK_GATEWAY_RECONCILIATION", "FULL_MONTH_CLOSE"), "defaultChecked": recipeID == "BANK_GATEWAY_RECONCILIATION"},
				{"id": "duplicates", "label": "Duplicate invoice detection", "enabled": counts["invoices"] > 0, "defaultChecked": true},
				{"id": "missing_documents", "label": "Missing document detection", "enabled": counts["bankTransactions"] > 0, "defaultChecked": true},
			},
			"estimatedOutputPage": estimated,
		})
	}
}

func RunReconciliation(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.AuthenticateRequest(db, r)
		if !ok {
			errorJSON(w, http.StatusUnauthorized, "unauthenticated")
			return
		}
		companyID, scoped := middleware.BooksCompany(db, w, r, auth)
		if !scoped {
			return
		}
		var body struct {
			RecipeID string `json:"recipeId"`
			Month    string `json:"month"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		runType := recipeToRunType(body.RecipeID)
		runID, err := createWorkflowRun(r.Context(), db, companyID, runType, &auth.UserID, map[string]any{"recipeId": body.RecipeID, "month": body.Month})
		if err != nil {
			errorJSON(w, http.StatusInternalServerError, "could not create workflow run")
			return
		}
		advanceWorkflowRun(r.Context(), db, runID, 20, "Loading financial records")
		result, err := runAndPersistReconciliation(r, db, companyID, runID)
		if err != nil {
			failed := "reconciliation failed"
			finishWorkflowRun(r.Context(), db, runID, "failed", &failed)
			errorJSON(w, http.StatusInternalServerError, failed)
			return
		}

		message := fmt.Sprintf("Reconciliation complete. Found %d new rule-based matches.", result["matchesFound"])
		if body.RecipeID == "BANK_TALLY_RECONCILIATION" {
			message = fmt.Sprintf("Ledger reconciliation report saved. Found %d new rule-based matches.", result["matchesFound"])
		}
		saveRunArtifact(r.Context(), db, runID, "reconciliation_report", message, map[string]any{"result": result, "recipeId": body.RecipeID})
		updateReconciliationRunTitle(r, db, companyID, runID)
		finishWorkflowRun(r.Context(), db, runID, "completed", nil)
		writeActionHistory(r.Context(), db, companyID, &runID, &auth.UserID, "reconciliation.run", message, "success", map[string]any{"matchesFound": result["matchesFound"], "recipeId": body.RecipeID, "runId": runID})
		writeAuditLog(r.Context(), db, companyID, &auth.UserID, auth.Email, "reconciliation.run", "reconciliation", nil, map[string]any{"matchesFound": result["matchesFound"], "recipeId": body.RecipeID, "runId": runID}, r.RemoteAddr)

		resp := map[string]any{}
		for k, v := range result {
			resp[k] = v
		}
		resp["message"] = message
		resp["runId"] = runID
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(resp)
	}
}

func UpdateReconciliationMatch(db *sql.DB, status string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.AuthenticateRequest(db, r)
		if !ok {
			errorJSON(w, http.StatusUnauthorized, "unauthenticated")
			return
		}
		companyID, scoped := middleware.BooksCompany(db, w, r, auth)
		if !scoped {
			return
		}
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil {
			errorJSON(w, http.StatusBadRequest, "Invalid id")
			return
		}
		var matchID int
		var bankID sql.NullInt64
		err = db.QueryRowContext(r.Context(),
			`UPDATE reconciliation_matches SET status = $3
			 WHERE id = $1 AND company_id = $2
			 RETURNING id, bank_transaction_id`,
			id, companyID, status).Scan(&matchID, &bankID)
		if err != nil {
			errorJSON(w, http.StatusNotFound, "Match not found")
			return
		}
		if status == "approved" && bankID.Valid {
			_, _ = db.ExecContext(r.Context(),
				`UPDATE bank_transactions SET status = 'verified' WHERE id = $1 AND company_id = $2`,
				bankID.Int64, companyID)
		}
		action := "reconciliation." + status
		if status == "needs_info" {
			action = "reconciliation.needs_info"
		}
		writeActionHistory(r.Context(), db, companyID, nil, &auth.UserID, action, fmt.Sprintf("Match #%d marked %s.", matchID, strings.ReplaceAll(status, "_", " ")), "success", map[string]any{"matchId": matchID})
		writeAuditLog(r.Context(), db, companyID, &auth.UserID, auth.Email, action, "reconciliation", matchID, map[string]any{"matchId": matchID}, r.RemoteAddr)
		item, _ := loadSingleMatch(r, db, companyID, matchID)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(item)
	}
}

func SendMatchToCA(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.AuthenticateRequest(db, r)
		if !ok {
			errorJSON(w, http.StatusUnauthorized, "unauthenticated")
			return
		}
		companyID, scoped := middleware.BooksCompany(db, w, r, auth)
		if !scoped {
			return
		}
		id, err := strconv.Atoi(r.PathValue("id"))
		if err != nil {
			errorJSON(w, http.StatusBadRequest, "Invalid id")
			return
		}
		var body struct {
			Note string `json:"note"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		var reason string
		var confidence int
		err = db.QueryRowContext(r.Context(),
			`SELECT reason, confidence_score FROM reconciliation_matches WHERE id = $1 AND company_id = $2`,
			id, companyID).Scan(&reason, &confidence)
		if err != nil {
			errorJSON(w, http.StatusNotFound, "Match not found")
			return
		}
		severity := "medium"
		if confidence < 60 {
			severity = "high"
		}
		var itemID int
		err = db.QueryRowContext(r.Context(),
			`INSERT INTO ca_review_items
			 (company_id, entity_type, entity_id, title, description, severity, status, founder_note, created_by)
			 VALUES ($1, 'reconciliation_match', $2, $3, $4, $5, 'pending', $6, $7)
			 RETURNING id`,
			companyID, id, fmt.Sprintf("Reconciliation match #%d needs CA review", id), reason, severity, nullString(body.Note), auth.UserID).Scan(&itemID)
		if err != nil {
			errorJSON(w, http.StatusInternalServerError, "could not create CA review item")
			return
		}
		_, _ = db.ExecContext(r.Context(), `UPDATE reconciliation_matches SET status = 'needs_info' WHERE id = $1 AND company_id = $2`, id, companyID)
		writeActionHistory(r.Context(), db, companyID, nil, &auth.UserID, "reconciliation.sent_to_ca", fmt.Sprintf("Sent match #%d to CA review.", id), "success", map[string]any{"matchId": id, "caReviewItemId": itemID})
		writeAuditLog(r.Context(), db, companyID, &auth.UserID, auth.Email, "reconciliation.sent_to_ca", "reconciliation", id, map[string]any{"matchId": id, "caReviewItemId": itemID}, r.RemoteAddr)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"ok": true, "id": itemID, "matchId": id, "status": "pending"})
	}
}

func loadReconciliationMatches(r *http.Request, db *sql.DB, companyID int, status string, runID string) ([]map[string]any, error) {
	rows, err := db.QueryContext(r.Context(),
		`SELECT id, bank_transaction_id, invoice_id, ledger_entry_id, match_type, confidence_score, reason, status, created_at::text, run_id
		 FROM reconciliation_matches
		 WHERE company_id = $1
		 ORDER BY created_at DESC`,
		companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	txns, _ := loadBankTxns(r, db, companyID)
	invoices, _ := loadInvoices(r, db, companyID)
	txnMap := map[int]bankTxn{}
	for _, txn := range txns {
		txnMap[txn.ID] = txn
	}
	invMap := map[int]invoiceRow{}
	for _, inv := range invoices {
		invMap[inv.ID] = inv
	}

	items := []map[string]any{}
	for rows.Next() {
		var id, confidence int
		var bankID, invoiceID, ledgerID sql.NullInt64
		var itemRunID sql.NullString
		var matchType, reason, matchStatus, createdAt string
		if err := rows.Scan(&id, &bankID, &invoiceID, &ledgerID, &matchType, &confidence, &reason, &matchStatus, &createdAt, &itemRunID); err != nil {
			continue
		}
		if status != "" && matchStatus != status {
			continue
		}
		if runID != "" && (!itemRunID.Valid || itemRunID.String != runID) {
			continue
		}
		item := mapMatchResponse(id, bankID, invoiceID, ledgerID, matchType, confidence, reason, matchStatus, createdAt, txnMap, invMap)
		if itemRunID.Valid {
			item["runId"] = itemRunID.String
		}
		items = append(items, item)
	}
	return items, nil
}

func loadSingleMatch(r *http.Request, db *sql.DB, companyID int, id int) (map[string]any, error) {
	txns, _ := loadBankTxns(r, db, companyID)
	invoices, _ := loadInvoices(r, db, companyID)
	txnMap := map[int]bankTxn{}
	for _, txn := range txns {
		txnMap[txn.ID] = txn
	}
	invMap := map[int]invoiceRow{}
	for _, inv := range invoices {
		invMap[inv.ID] = inv
	}
	var bankID, invoiceID, ledgerID sql.NullInt64
	var matchType, reason, status, createdAt string
	var confidence int
	err := db.QueryRowContext(r.Context(),
		`SELECT bank_transaction_id, invoice_id, ledger_entry_id, match_type, confidence_score, reason, status, created_at::text
		 FROM reconciliation_matches WHERE id = $1 AND company_id = $2`,
		id, companyID).Scan(&bankID, &invoiceID, &ledgerID, &matchType, &confidence, &reason, &status, &createdAt)
	if err != nil {
		return nil, err
	}
	return mapMatchResponse(id, bankID, invoiceID, ledgerID, matchType, confidence, reason, status, createdAt, txnMap, invMap), nil
}

func mapMatchResponse(id int, bankID sql.NullInt64, invoiceID sql.NullInt64, ledgerID sql.NullInt64, matchType string, confidence int, reason string, status string, createdAt string, txnMap map[int]bankTxn, invMap map[int]invoiceRow) map[string]any {
	item := map[string]any{
		"id":                id,
		"bankTransactionId": nullableInt(bankID),
		"invoiceId":         nullableInt(invoiceID),
		"ledgerEntryId":     nullableInt(ledgerID),
		"matchType":         matchType,
		"confidenceScore":   confidence,
		"reason":            reason,
		"status":            status,
		"createdAt":         createdAt,
	}
	if bankID.Valid {
		if txn, ok := txnMap[int(bankID.Int64)]; ok {
			item["bankTransaction"] = map[string]any{"id": txn.ID, "date": txn.Date, "narration": txn.Narration, "amount": txn.Amount, "type": txn.Type, "source": txn.Source, "bankName": txn.BankName, "reference": txn.Reference, "status": txn.Status, "confidenceScore": txn.ConfidenceScore, "matchedInvoiceId": txn.MatchedInvoice, "note": txn.Note}
		}
	}
	if invoiceID.Valid {
		if inv, ok := invMap[int(invoiceID.Int64)]; ok {
			item["invoice"] = map[string]any{"id": inv.ID, "invoiceNumber": inv.InvoiceNumber, "vendorName": inv.VendorName, "customerName": inv.CustomerName, "gstin": inv.GSTIN, "date": inv.Date, "amount": inv.Amount, "gstAmount": inv.GSTAmount, "type": inv.Type, "paymentStatus": inv.PaymentStatus, "status": inv.Status, "linkedTransactionId": inv.LinkedTxnID}
		}
	}
	return item
}

func loadReconciliationFolders(r *http.Request, db *sql.DB, companyID int) ([]reconciliationFolder, error) {
	rows, err := db.QueryContext(r.Context(),
		`SELECT wr.id, wr.title, wr.run_type, wr.status, wr.created_at::text, wr.completed_at::text,
		        COALESCE(COUNT(rm.id), 0)::int
		 FROM workflow_runs wr
		 LEFT JOIN reconciliation_matches rm ON rm.run_id = wr.id AND rm.company_id = wr.company_id
		 WHERE wr.company_id = $1
		   AND wr.run_type IN ('bank_tally_reconciliation','bank_invoice_reconciliation','bank_gateway_reconciliation','bank_payroll_reconciliation','full_month_close')
		 GROUP BY wr.id, wr.title, wr.run_type, wr.status, wr.created_at, wr.completed_at
		 ORDER BY wr.created_at DESC
		 LIMIT 50`,
		companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	folders := []reconciliationFolder{}
	for rows.Next() {
		var f reconciliationFolder
		var completed sql.NullString
		if err := rows.Scan(&f.RunID, &f.Title, &f.RunType, &f.Status, &f.CreatedAt, &completed, &f.MatchCount); err != nil {
			continue
		}
		if completed.Valid {
			s := completed.String
			f.CompletedAt = &s
		}
		f.SourceFiles, f.SourceTypes = loadRunSourceLabels(r, db, f.RunID)
		folders = append(folders, f)
	}
	for i := range folders {
		folders[i].Name = fmt.Sprintf("Reconciliation %d", len(folders)-i)
		if len(folders[i].SourceFiles) > 0 {
			folders[i].Title = folders[i].Name + " - " + strings.Join(folders[i].SourceFiles[:minInt(len(folders[i].SourceFiles), 2)], " + ")
		} else if folders[i].Title == "" {
			folders[i].Title = folders[i].Name
		}
	}
	return folders, rows.Err()
}

func loadRunSourceLabels(r *http.Request, db *sql.DB, runID string) ([]string, []string) {
	rows, err := db.QueryContext(r.Context(),
		`SELECT DISTINCT source_type, file_name FROM run_sources WHERE run_id = $1 ORDER BY file_name ASC`,
		runID)
	if err != nil {
		return []string{}, []string{}
	}
	defer rows.Close()
	files := []string{}
	types := []string{}
	seenFiles := map[string]bool{}
	seenTypes := map[string]bool{}
	for rows.Next() {
		var sourceType, fileName string
		if err := rows.Scan(&sourceType, &fileName); err != nil {
			continue
		}
		if fileName != "" && !seenFiles[fileName] {
			files = append(files, fileName)
			seenFiles[fileName] = true
		}
		if sourceType != "" && !seenTypes[sourceType] {
			types = append(types, sourceType)
			seenTypes[sourceType] = true
		}
	}
	return files, types
}

func recordReconciliationSources(r *http.Request, db *sql.DB, runID string, uploadIDs []int) {
	seen := map[int]bool{}
	for _, uploadID := range uploadIDs {
		if uploadID <= 0 || seen[uploadID] {
			continue
		}
		seen[uploadID] = true
		var sourceType, fileName string
		var rowCount sql.NullInt64
		err := db.QueryRowContext(r.Context(),
			`SELECT source_type, file_name, record_count FROM upload_batches WHERE id = $1`,
			uploadID).Scan(&sourceType, &fileName, &rowCount)
		if err != nil {
			continue
		}
		count := 0
		if rowCount.Valid {
			count = int(rowCount.Int64)
		}
		_, _ = db.ExecContext(r.Context(),
			`INSERT INTO run_sources (run_id, upload_id, source_type, file_name, row_count, status)
			 SELECT $1, $2, $3, $4, $5, 'used_for_reconciliation'
			 WHERE NOT EXISTS (
			   SELECT 1 FROM run_sources WHERE run_id = $1 AND upload_id = $2
			 )`,
			runID, uploadID, sourceType, fileName, count)
	}
}

func updateReconciliationRunTitle(r *http.Request, db *sql.DB, companyID int, runID string) {
	files, _ := loadRunSourceLabels(r, db, runID)
	folders, err := loadReconciliationFolders(r, db, companyID)
	sequence := 1
	if err == nil {
		for _, folder := range folders {
			if folder.RunID == runID {
				if n, parseErr := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(folder.Name, "Reconciliation"))); parseErr == nil {
					sequence = n
				}
				break
			}
		}
	}
	title := fmt.Sprintf("Reconciliation %d", sequence)
	if len(files) > 0 {
		title = title + " - " + strings.Join(files[:minInt(len(files), 2)], " + ")
	}
	_, _ = db.ExecContext(r.Context(), `UPDATE workflow_runs SET title = $2 WHERE id = $1 AND company_id = $3`, runID, title, companyID)
}

func runAndPersistReconciliation(r *http.Request, db *sql.DB, companyID int, runID string) (map[string]int, error) {
	txns, err := loadBankTxns(r, db, companyID)
	if err != nil {
		return nil, err
	}
	invoices, _ := loadInvoices(r, db, companyID)
	ledger, _ := loadLedger(r, db, companyID)
	payroll, _ := loadPayroll(r, db, companyID)
	gateway, _ := loadGateway(r, db, companyID)
	existing := existingMatchKeys(r, db, companyID)
	suggestions := runFullMatching(txns, invoices, ledger, payroll, gateway)
	newMatches := []suggestion{}
	for _, s := range suggestions {
		if !existing[matchKey(s)] {
			newMatches = append(newMatches, s)
		}
		if len(newMatches) >= 50 {
			break
		}
	}
	for _, s := range newMatches {
		_, err := db.ExecContext(r.Context(),
			`INSERT INTO reconciliation_matches
			 (company_id, bank_transaction_id, invoice_id, ledger_entry_id, run_id, match_type, confidence_score, reason, status)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			companyID, ptrIntValue(s.BankTransactionID), ptrIntValue(s.InvoiceID), ptrIntValue(s.LedgerEntryID), runID, s.MatchType, s.ConfidenceScore, s.Reason, s.Status)
		if err != nil {
			return nil, err
		}
		recordReconciliationSources(r, db, runID, s.SourceUploadIDs)
	}
	verified := 0
	potential := 0
	for _, match := range newMatches {
		if match.ConfidenceScore >= 85 {
			verified++
		} else if match.ConfidenceScore >= 60 {
			potential++
		}
	}
	unverified := 0
	for _, txn := range txns {
		if txn.ConfidenceScore < 60 {
			unverified++
		}
	}
	return map[string]int{"matchesFound": len(newMatches), "newVerified": verified, "newPotential": potential, "newUnverified": unverified}, nil
}

func runFullMatching(txns []bankTxn, invoices []invoiceRow, ledger []ledgerRow, payroll []payrollRow, gateway []gatewayRow) []suggestion {
	out := []suggestion{}
	out = append(out, matchBankToInvoices(txns, invoices)...)
	out = append(out, matchBankToLedger(txns, ledger)...)
	out = append(out, detectDuplicates(txns, invoices)...)
	out = append(out, detectPartialPayments(txns, invoices)...)
	out = append(out, detectSplitPayments(txns, invoices)...)
	out = append(out, detectGatewaySettlements(txns, gateway)...)
	out = append(out, detectPayrollMatches(txns, payroll)...)
	deduped := map[string]suggestion{}
	for _, s := range out {
		key := matchKey(s)
		if existing, ok := deduped[key]; !ok || s.ConfidenceScore > existing.ConfidenceScore {
			deduped[key] = s
		}
	}
	final := []suggestion{}
	for _, s := range deduped {
		final = append(final, s)
	}
	sort.Slice(final, func(i, j int) bool { return final[i].ConfidenceScore > final[j].ConfidenceScore })
	return final
}

func matchBankToInvoices(txns []bankTxn, invoices []invoiceRow) []suggestion {
	out := []suggestion{}
	for _, txn := range txns {
		var best *suggestion
		refs := extractReferences(txn.Narration + " " + stringPtrValue(txn.Reference))
		for _, inv := range invoices {
			parties := strings.TrimSpace(inv.VendorName + " " + stringPtrValue(inv.CustomerName))
			refMatch := containsString(refs, strings.ToUpper(inv.InvoiceNumber)) || strings.Contains(strings.ToUpper(txn.Narration), strings.ToUpper(inv.InvoiceNumber))
			dateDistance := calculateDateDistance(txn.Date, inv.Date)
			nameSimilarity := calculateNameSimilarity(txn.Narration, parties)
			score := calculateConfidenceScore(math.Abs(txn.Amount-inv.Amount) <= 1, dateDistance, nameSimilarity, refMatch, txn.Type == invoiceExpectedTxnType(inv.Type))
			bankID := txn.ID
			invoiceID := inv.ID
			candidate := suggestion{BankTransactionID: &bankID, InvoiceID: &invoiceID, MatchType: statusFromScore(score), ConfidenceScore: score, Reason: fmt.Sprintf("Invoice %s: amount %s, date distance %d days, name similarity %d%%.", inv.InvoiceNumber, boolWord(math.Abs(txn.Amount-inv.Amount) <= 1, "matches", "differs"), dateDistance, nameSimilarity), Status: "pending", SourceUploadIDs: sourceIDs(txn.SourceUploadID, inv.SourceUploadID)}
			if best == nil || candidate.ConfidenceScore > best.ConfidenceScore {
				best = &candidate
			}
		}
		if best != nil && best.ConfidenceScore >= 45 {
			out = append(out, *best)
		}
	}
	return out
}

func matchBankToLedger(txns []bankTxn, ledger []ledgerRow) []suggestion {
	out := []suggestion{}
	for _, txn := range txns {
		var bestEntry *ledgerRow
		bestScore := -1
		for i := range ledger {
			entry := ledger[i]
			score := calculateConfidenceScore(math.Abs(txn.Amount-entry.Amount) <= 1, calculateDateDistance(txn.Date, entry.Date), calculateNameSimilarity(txn.Narration, entry.LedgerName), entry.VoucherNumber != nil && strings.Contains(strings.ToUpper(txn.Narration), strings.ToUpper(*entry.VoucherNumber)), txn.Type == ledgerExpectedTxnType(entry.DebitCredit))
			if score > bestScore {
				bestScore = score
				bestEntry = &ledger[i]
			}
		}
		if bestEntry != nil && bestScore >= 55 {
			bankID := txn.ID
			ledgerID := bestEntry.ID
			matchType := "potential_ledger_match"
			if bestScore >= 85 {
				matchType = "ledger_match"
			}
			out = append(out, suggestion{BankTransactionID: &bankID, LedgerEntryID: &ledgerID, MatchType: matchType, ConfidenceScore: bestScore, Reason: fmt.Sprintf("Ledger %s: rules-first match with amount/date/name/reference scoring.", bestEntry.LedgerName), Status: "pending", SourceUploadIDs: sourceIDs(txn.SourceUploadID, bestEntry.SourceUploadID)})
		}
	}
	return out
}

func detectDuplicates(txns []bankTxn, invoices []invoiceRow) []suggestion {
	out := []suggestion{}
	seen := map[string]bankTxn{}
	for _, txn := range txns {
		key := fmt.Sprintf("%s:%.2f:%s", txn.Type, txn.Amount, truncate(normalizeName(txn.Narration), 28))
		if prev, ok := seen[key]; ok && calculateDateDistance(prev.Date, txn.Date) <= 7 {
			bankID := txn.ID
			out = append(out, suggestion{BankTransactionID: &bankID, MatchType: "duplicate", ConfidenceScore: 72, Reason: fmt.Sprintf("Possible duplicate of transaction #%d: same amount and similar narration within 7 days.", prev.ID), Status: "pending", SourceUploadIDs: sourceIDs(txn.SourceUploadID, prev.SourceUploadID)})
		}
		seen[key] = txn
	}
	invoiceNumbers := map[string]bool{}
	for _, inv := range invoices {
		key := strings.ToUpper(inv.InvoiceNumber)
		if invoiceNumbers[key] {
			invoiceID := inv.ID
			out = append(out, suggestion{InvoiceID: &invoiceID, MatchType: "duplicate_invoice", ConfidenceScore: 80, Reason: fmt.Sprintf("Duplicate invoice number %s detected.", inv.InvoiceNumber), Status: "pending", SourceUploadIDs: sourceIDs(inv.SourceUploadID)})
		}
		invoiceNumbers[key] = true
	}
	return out
}

func detectPartialPayments(txns []bankTxn, invoices []invoiceRow) []suggestion {
	out := []suggestion{}
	for _, s := range matchBankToInvoices(txns, invoices) {
		if s.ConfidenceScore >= 45 && s.ConfidenceScore < 85 {
			s.MatchType = "partial_payment"
			s.Reason += " Possible partial payment - needs CA review."
			out = append(out, s)
		}
	}
	return out
}

func detectSplitPayments(txns []bankTxn, invoices []invoiceRow) []suggestion {
	out := []suggestion{}
	for _, inv := range invoices {
		nearby := []bankTxn{}
		total := 0.0
		for _, txn := range txns {
			if txn.Type == invoiceExpectedTxnType(inv.Type) && calculateDateDistance(txn.Date, inv.Date) <= 7 {
				nearby = append(nearby, txn)
				total += txn.Amount
			}
		}
		if len(nearby) > 1 && math.Abs(total-inv.Amount) <= 5 {
			invoiceID := inv.ID
			sourceIDsForSplit := sourceIDs(inv.SourceUploadID)
			for _, txn := range nearby {
				sourceIDsForSplit = append(sourceIDsForSplit, sourceIDs(txn.SourceUploadID)...)
			}
			out = append(out, suggestion{InvoiceID: &invoiceID, MatchType: "split_payment", ConfidenceScore: 78, Reason: fmt.Sprintf("%d nearby bank entries add up to invoice %s.", len(nearby), inv.InvoiceNumber), Status: "pending", SourceUploadIDs: sourceIDsForSplit})
		}
	}
	return out
}

func detectGatewaySettlements(txns []bankTxn, settlements []gatewayRow) []suggestion {
	out := []suggestion{}
	for _, settlement := range settlements {
		for _, txn := range txns {
			if txn.Type != "credit" {
				continue
			}
			containsRef := strings.Contains(strings.ToUpper(txn.Narration), strings.ToUpper(settlement.SettlementID)) || (settlement.BankReference != nil && strings.Contains(strings.ToUpper(txn.Narration), strings.ToUpper(*settlement.BankReference)))
			if math.Abs(txn.Amount-settlement.NetAmount) <= 1000 || containsRef {
				score := 74
				if math.Abs(txn.Amount-settlement.NetAmount) <= 1 {
					score = 95
				}
				matchType := "gateway_settlement_mismatch"
				if score >= 85 {
					matchType = "gateway_settlement_match"
				}
				bankID := txn.ID
				out = append(out, suggestion{BankTransactionID: &bankID, MatchType: matchType, ConfidenceScore: score, Reason: fmt.Sprintf("%s settlement %s compared with bank credit.", settlement.Provider, settlement.SettlementID), Status: "pending", SourceUploadIDs: sourceIDs(txn.SourceUploadID)})
				break
			}
		}
	}
	return out
}

func detectPayrollMatches(txns []bankTxn, payroll []payrollRow) []suggestion {
	totals := map[string]float64{}
	for _, entry := range payroll {
		if entry.PaymentDate != nil {
			totals[*entry.PaymentDate] += entry.NetAmount
		}
	}
	out := []suggestion{}
	for _, txn := range txns {
		if txn.Type != "debit" || !regexp.MustCompile(`(?i)salary|payroll|sal`).MatchString(txn.Narration) {
			continue
		}
		expected := totals[txn.Date]
		score := 40
		if math.Abs(expected-txn.Amount) <= 1 {
			score = 98
		} else if expected > 0 {
			score = 68
		}
		matchType := "payroll_mismatch"
		if score >= 85 {
			matchType = "payroll_match"
		}
		reason := "Salary debit found but no payroll-sheet total for that payment date."
		if expected > 0 {
			reason = fmt.Sprintf("Payroll register total INR %.2f compared with salary debit.", expected)
		}
		bankID := txn.ID
		out = append(out, suggestion{BankTransactionID: &bankID, MatchType: matchType, ConfidenceScore: score, Reason: reason, Status: "pending", SourceUploadIDs: sourceIDs(txn.SourceUploadID)})
	}
	return out
}

func loadBankTxns(r *http.Request, db *sql.DB, companyID int) ([]bankTxn, error) {
	rows, err := db.QueryContext(r.Context(), `SELECT id, date, narration, amount::text, type, COALESCE(source,''), bank_name, reference, status, COALESCE(confidence_score,0), matched_invoice_id, note, source_upload_id FROM bank_transactions WHERE company_id = $1`, companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []bankTxn{}
	for rows.Next() {
		var t bankTxn
		var amount string
		var bankName, reference, note sql.NullString
		var matched, sourceUploadID sql.NullInt64
		if err := rows.Scan(&t.ID, &t.Date, &t.Narration, &amount, &t.Type, &t.Source, &bankName, &reference, &t.Status, &t.ConfidenceScore, &matched, &note, &sourceUploadID); err == nil {
			t.Amount = toFloat(amount)
			t.BankName = nullableStringPtr(bankName)
			t.Reference = nullableStringPtr(reference)
			t.MatchedInvoice = nullableIntPtr(matched)
			t.Note = nullableStringPtr(note)
			t.SourceUploadID = nullableIntPtr(sourceUploadID)
			out = append(out, t)
		}
	}
	return out, rows.Err()
}

func loadInvoices(r *http.Request, db *sql.DB, companyID int) ([]invoiceRow, error) {
	rows, err := db.QueryContext(r.Context(), `SELECT id, invoice_number, vendor_name, customer_name, gstin, date, amount::text, gst_amount::text, type, payment_status, status, linked_transaction_id, source_upload_id FROM invoices WHERE company_id = $1`, companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []invoiceRow{}
	for rows.Next() {
		var inv invoiceRow
		var amount string
		var gstAmount sql.NullString
		var customer, gstin sql.NullString
		var linked, sourceUploadID sql.NullInt64
		if err := rows.Scan(&inv.ID, &inv.InvoiceNumber, &inv.VendorName, &customer, &gstin, &inv.Date, &amount, &gstAmount, &inv.Type, &inv.PaymentStatus, &inv.Status, &linked, &sourceUploadID); err == nil {
			inv.Amount = toFloat(amount)
			inv.CustomerName = nullableStringPtr(customer)
			inv.GSTIN = nullableStringPtr(gstin)
			if gstAmount.Valid {
				v := toFloat(gstAmount.String)
				inv.GSTAmount = &v
			}
			inv.LinkedTxnID = nullableIntPtr(linked)
			inv.SourceUploadID = nullableIntPtr(sourceUploadID)
			out = append(out, inv)
		}
	}
	return out, rows.Err()
}

func loadLedger(r *http.Request, db *sql.DB, companyID int) ([]ledgerRow, error) {
	rows, err := db.QueryContext(r.Context(), `SELECT id, date, ledger_name, voucher_number, amount::text, debit_credit, source_upload_id FROM ledger_entries WHERE company_id = $1`, companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ledgerRow{}
	for rows.Next() {
		var e ledgerRow
		var amount string
		var voucher sql.NullString
		var sourceUploadID sql.NullInt64
		if err := rows.Scan(&e.ID, &e.Date, &e.LedgerName, &voucher, &amount, &e.DebitCredit, &sourceUploadID); err == nil {
			e.Amount = toFloat(amount)
			e.VoucherNumber = nullableStringPtr(voucher)
			e.SourceUploadID = nullableIntPtr(sourceUploadID)
			out = append(out, e)
		}
	}
	return out, rows.Err()
}

func loadPayroll(r *http.Request, db *sql.DB, companyID int) ([]payrollRow, error) {
	rows, err := db.QueryContext(r.Context(), `SELECT id, employee_name, month, net_amount::text, payment_date, bank_reference, status FROM payroll_entries WHERE company_id = $1`, companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []payrollRow{}
	for rows.Next() {
		var e payrollRow
		var amount string
		var paymentDate, reference sql.NullString
		if err := rows.Scan(&e.ID, &e.EmployeeName, &e.Month, &amount, &paymentDate, &reference, &e.Status); err == nil {
			e.NetAmount = toFloat(amount)
			e.PaymentDate = nullableStringPtr(paymentDate)
			e.BankReference = nullableStringPtr(reference)
			out = append(out, e)
		}
	}
	return out, rows.Err()
}

func loadGateway(r *http.Request, db *sql.DB, companyID int) ([]gatewayRow, error) {
	rows, err := db.QueryContext(r.Context(), `SELECT id, provider, settlement_id, gross_amount::text, fees::text, gst_on_fees::text, net_amount::text, settlement_date, bank_reference, status FROM gateway_settlements WHERE company_id = $1`, companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []gatewayRow{}
	for rows.Next() {
		var g gatewayRow
		var gross, fees, net string
		var gst, reference sql.NullString
		if err := rows.Scan(&g.ID, &g.Provider, &g.SettlementID, &gross, &fees, &gst, &net, &g.SettlementDate, &reference, &g.Status); err == nil {
			g.GrossAmount = toFloat(gross)
			g.Fees = toFloat(fees)
			if gst.Valid {
				v := toFloat(gst.String)
				g.GSTOnFees = &v
			}
			g.NetAmount = toFloat(net)
			g.BankReference = nullableStringPtr(reference)
			out = append(out, g)
		}
	}
	return out, rows.Err()
}

func existingMatchKeys(r *http.Request, db *sql.DB, companyID int) map[string]bool {
	rows, err := db.QueryContext(r.Context(), `SELECT bank_transaction_id, invoice_id, ledger_entry_id, match_type FROM reconciliation_matches WHERE company_id = $1`, companyID)
	if err != nil {
		return map[string]bool{}
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var bankID, invoiceID, ledgerID sql.NullInt64
		var matchType string
		if err := rows.Scan(&bankID, &invoiceID, &ledgerID, &matchType); err == nil {
			out[fmt.Sprintf("%s:%s:%s:%s", nullIntKey(bankID), nullIntKey(invoiceID), nullIntKey(ledgerID), matchType)] = true
		}
	}
	return out
}

func countRows(r *http.Request, db *sql.DB, table string, companyID int, extraWhere string) int {
	allowed := map[string]bool{"bank_transactions": true, "invoices": true, "ledger_entries": true, "payroll_entries": true, "gateway_settlements": true, "gst_records": true, "ai_extractions": true}
	if !allowed[table] {
		return 0
	}
	query := fmt.Sprintf("SELECT count(*) FROM %s WHERE company_id = $1", table)
	if extraWhere != "" {
		query += " AND " + extraWhere
	}
	var n int
	_ = db.QueryRowContext(r.Context(), query, companyID).Scan(&n)
	return n
}

func recipeToRunType(recipeID string) string {
	switch recipeID {
	case "BANK_TALLY_RECONCILIATION":
		return "bank_tally_reconciliation"
	case "BANK_INVOICE_RECONCILIATION":
		return "bank_invoice_reconciliation"
	case "BANK_GATEWAY_RECONCILIATION":
		return "bank_gateway_reconciliation"
	case "BANK_PAYROLL_RECONCILIATION":
		return "bank_payroll_reconciliation"
	case "GST_TDS_REVIEW":
		return "gst_tds_review"
	case "FULL_MONTH_CLOSE":
		return "full_month_close"
	default:
		return "bank_tally_reconciliation"
	}
}

func statusFromScore(score int) string {
	if score >= 85 {
		return "exact"
	}
	if score >= 60 {
		return "potential"
	}
	return "unverified"
}

func calculateConfidenceScore(amountMatches bool, dateDistance int, nameSimilarity int, referenceMatches bool, sourceConsistent bool) int {
	score := 0
	if amountMatches {
		score += 35
	}
	if dateDistance <= 1 {
		score += 15
	} else if dateDistance <= 3 {
		score += 10
	} else if dateDistance <= 7 {
		score += 5
	}
	score += int(math.Round(math.Min(float64(nameSimilarity), 100) * 0.2))
	if referenceMatches {
		score += 20
	}
	if sourceConsistent {
		score += 10
	}
	if score > 100 {
		return 100
	}
	return score
}

func normalizeName(name string) string {
	normalized := regexp.MustCompile(`[^a-z0-9\s]+`).ReplaceAllString(strings.ToLower(name), " ")
	for _, suffix := range []string{"pvt ltd", "private limited", "ltd", "llp", "inc", "technologies", "technology", "solutions", "enterprises", "india", "corp", "corporation"} {
		normalized = regexp.MustCompile(`\b`+regexp.QuoteMeta(suffix)+`\b`).ReplaceAllString(normalized, " ")
	}
	return strings.TrimSpace(regexp.MustCompile(`\s+`).ReplaceAllString(normalized, " "))
}

func calculateNameSimilarity(a string, b string) int {
	left := tokenSet(normalizeName(a))
	right := tokenSet(normalizeName(b))
	if len(left) == 0 || len(right) == 0 {
		return 0
	}
	intersection := 0
	for token := range left {
		if right[token] {
			intersection++
		}
	}
	union := len(left)
	for token := range right {
		if !left[token] {
			union++
		}
	}
	return int(math.Round(float64(intersection) / float64(union) * 100))
}

func calculateDateDistance(a string, b string) int {
	left, errA := time.Parse("2006-01-02", parseDate(a))
	right, errB := time.Parse("2006-01-02", parseDate(b))
	if errA != nil || errB != nil {
		return 999
	}
	return int(math.Abs(math.Round(left.Sub(right).Hours() / 24)))
}

func extractReferences(narration string) []string {
	patterns := []string{`(?i)\bUTR[A-Z0-9-]*\d+\b`, `(?i)\bRRN[A-Z0-9-]*\d+\b`, `(?i)\bNEFT[A-Z0-9-]*\d+\b`, `(?i)\bRTGS[A-Z0-9-]*\d+\b`, `(?i)\bIMPS[A-Z0-9-]*\d+\b`, `(?i)\bUPI[A-Z0-9-]*\d+\b`, `(?i)\bINV[-/]?[A-Z0-9-]*\d+\b`, `(?i)\b[A-Z]{2,5}[-/]?STL[-/]?\d+\b`, `(?i)\b[A-Z]{2,6}[-/]\d{4}[-/]\d{2,}\b`}
	seen := map[string]bool{}
	out := []string{}
	for _, pattern := range patterns {
		for _, ref := range regexp.MustCompile(pattern).FindAllString(narration, -1) {
			upper := strings.ToUpper(ref)
			if !seen[upper] {
				seen[upper] = true
				out = append(out, upper)
			}
		}
	}
	return out
}

func matchKey(s suggestion) string {
	return fmt.Sprintf("%s:%s:%s:%s", ptrIntKey(s.BankTransactionID), ptrIntKey(s.InvoiceID), ptrIntKey(s.LedgerEntryID), s.MatchType)
}

func nullableInt(v sql.NullInt64) any {
	if !v.Valid {
		return nil
	}
	return int(v.Int64)
}

func nullableIntPtr(v sql.NullInt64) *int {
	if !v.Valid {
		return nil
	}
	n := int(v.Int64)
	return &n
}

func nullableStringPtr(v sql.NullString) *string {
	if !v.Valid {
		return nil
	}
	s := v.String
	return &s
}

func ptrIntValue(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}

func ptrIntKey(v *int) string {
	if v == nil {
		return "none"
	}
	return strconv.Itoa(*v)
}

func nullIntKey(v sql.NullInt64) string {
	if !v.Valid {
		return "none"
	}
	return strconv.Itoa(int(v.Int64))
}

func stringPtrValue(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func toFloat(s string) float64 {
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

func tokenSet(s string) map[string]bool {
	out := map[string]bool{}
	for _, token := range strings.Fields(s) {
		out[token] = true
	}
	return out
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

func invoiceExpectedTxnType(invoiceType string) string {
	if invoiceType == "sales" {
		return "credit"
	}
	return "debit"
}

func ledgerExpectedTxnType(debitCredit string) string {
	if debitCredit == "credit" {
		return "credit"
	}
	return "debit"
}

func boolWord(ok bool, yes string, no string) string {
	if ok {
		return yes
	}
	return no
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func minInt(a int, b int) int {
	if a < b {
		return a
	}
	return b
}

func sourceIDs(ids ...*int) []int {
	out := []int{}
	seen := map[int]bool{}
	for _, id := range ids {
		if id == nil || *id <= 0 || seen[*id] {
			continue
		}
		seen[*id] = true
		out = append(out, *id)
	}
	return out
}
