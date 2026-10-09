package routes

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/finverify/api-go/internal/middleware"
)

type importRequest struct {
	Month       string   `json:"month"`
	SourceTypes []string `json:"sourceTypes"`
}

type uploadCandidate struct {
	ID                  int
	SourceType          string
	FileName            string
	Status              string
	DocumentStatus      string
	ExtractedTextStatus string
	DetectedColumnsText string
}

type parsedMetadata struct {
	Parser     string
	Columns    []string
	ParsedRows []map[string]any
}

type importSummary struct {
	Table    string
	Inserted int
	Skipped  int
	Notes    []string
}

func ImportSelectedSources(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		handleImportParsedUploads(w, r, db, true)
	}
}

func ImportAllParsed(db *sql.DB) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		handleImportParsedUploads(w, r, db, false)
	}
}

func handleImportParsedUploads(w http.ResponseWriter, r *http.Request, db *sql.DB, requireSelection bool) {
	if db == nil {
		errorJSON(w, http.StatusServiceUnavailable, "database not configured")
		return
	}
	auth, ok := middleware.AuthenticateRequest(db, r)
	if !ok {
		errorJSON(w, http.StatusUnauthorized, "unauthenticated")
		return
	}
	companyID, scoped := middleware.BooksCompany(db, w, r, auth)
	if !scoped {
		return
	}

	var body importRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	selected := map[string]bool{}
	for _, source := range body.SourceTypes {
		if normalized := normalizeSourceType(source); normalized != "" {
			selected[normalized] = true
		}
	}
	if requireSelection && len(selected) == 0 {
		errorJSON(w, http.StatusBadRequest, "Select at least one source type to import.")
		return
	}

	runID, err := createWorkflowRun(r.Context(), db, companyID, "import_records", &auth.UserID, map[string]any{"sourceTypes": body.SourceTypes, "month": body.Month})
	if err != nil {
		errorJSON(w, http.StatusInternalServerError, "could not create workflow run")
		return
	}
	advanceWorkflowRun(r.Context(), db, runID, 15, "Finding parsed uploads")

	candidates, err := listImportCandidates(r, db, companyID)
	if err != nil {
		failed := "could not list parsed uploads"
		finishWorkflowRun(r.Context(), db, runID, "failed", &failed)
		errorJSON(w, http.StatusInternalServerError, failed)
		return
	}

	imported := map[string]int{
		"bankTransactions":   0,
		"invoices":           0,
		"ledgerEntries":      0,
		"gstRecords":         0,
		"payrollEntries":     0,
		"gatewaySettlements": 0,
	}
	skippedAlreadyImported := 0
	skippedNoStructuredRows := 0
	skippedNoImportedRows := 0
	pendingInvoiceExtractions := 0
	errors := []string{}

	total := len(candidates)
	for i, batch := range candidates {
		normalizedSource := normalizeSourceType(batch.SourceType)
		if requireSelection && !selected[normalizedSource] {
			continue
		}
		if batch.Status == "batch_confirmed" || batch.Status == "imported" {
			skippedAlreadyImported++
			continue
		}

		metadata := parseDetectedColumns(batch.DetectedColumnsText)
		if len(metadata.ParsedRows) == 0 {
			if (normalizedSource == "invoices" || normalizedSource == "invoice") && batch.ExtractedTextStatus == "text_extracted" {
				pendingInvoiceExtractions++
				continue
			}
			skippedNoStructuredRows++
			continue
		}

		advanceWorkflowRun(r.Context(), db, runID, 20+int(float64(i+1)/math.Max(float64(total), 1)*60), "Importing "+batch.FileName)
		summary, err := ingestRows(r, db, companyID, batch.SourceType, batch.FileName, batch.ID, metadata.ParsedRows)
		if err != nil {
			errors = append(errors, fmt.Sprintf("%s: %s", batch.FileName, err.Error()))
			continue
		}
		addImportCount(imported, summary.Table, summary.Inserted)
		if summary.Inserted > 0 {
			_, _ = db.ExecContext(r.Context(),
				`UPDATE upload_batches
				 SET status = 'batch_confirmed', record_count = $3, run_id = $4
				 WHERE id = $1 AND company_id = $2`,
				batch.ID, companyID, summary.Inserted, runID)
			addRunSource(r.Context(), db, runID, batch.ID, batch.SourceType, batch.FileName, summary.Inserted, "imported")
		} else {
			skippedNoImportedRows++
			errors = append(errors, fmt.Sprintf("%s: %s", batch.FileName, strings.Join(summary.Notes, " ")))
		}
	}

	totalImported := 0
	for _, n := range imported {
		totalImported += n
	}
	advanceWorkflowRun(r.Context(), db, runID, 90, "Saving import summary")
	payload := map[string]any{
		"imported":                  imported,
		"skippedAlreadyImported":    skippedAlreadyImported,
		"skippedNoStructuredRows":   skippedNoStructuredRows,
		"skippedNoImportedRows":     skippedNoImportedRows,
		"pendingInvoiceExtractions": pendingInvoiceExtractions,
		"errors":                    errors,
	}
	saveRunArtifact(r.Context(), db, runID, "import_summary", "Import summary", payload)
	finishWorkflowRun(r.Context(), db, runID, "completed", nil)
	writeActionHistory(r.Context(), db, companyID, &runID, &auth.UserID, "upload.batch_import_completed", fmt.Sprintf("Imported %d rule-based records.", totalImported), "success", payload)
	writeAuditLog(r.Context(), db, companyID, &auth.UserID, auth.Email, "upload.batch_import_completed", "document", nil, map[string]any{"runId": runID, "imported": imported}, r.RemoteAddr)

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ok":                        true,
		"runId":                     runID,
		"imported":                  imported,
		"pendingInvoiceExtractions": pendingInvoiceExtractions,
		"skippedAlreadyImported":    skippedAlreadyImported,
		"skippedNoStructuredRows":   skippedNoStructuredRows,
		"skippedNoImportedRows":     skippedNoImportedRows,
		"errors":                    errors,
		"message":                   fmt.Sprintf("Imported %d records.", totalImported),
	})
}

func listImportCandidates(r *http.Request, db *sql.DB, companyID int) ([]uploadCandidate, error) {
	rows, err := db.QueryContext(r.Context(),
		`SELECT b.id, b.source_type, b.file_name, b.status,
		        d.status, COALESCE(d.extracted_text_status, ''), COALESCE(d.detected_columns::text, '{}')
		 FROM upload_batches b
		 JOIN documents d ON d.upload_batch_id = b.id AND d.company_id = b.company_id
		 WHERE b.company_id = $1 AND b.status <> 'removed' AND d.status = 'parsed'
		 ORDER BY b.uploaded_at DESC`,
		companyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []uploadCandidate{}
	for rows.Next() {
		var c uploadCandidate
		if err := rows.Scan(&c.ID, &c.SourceType, &c.FileName, &c.Status, &c.DocumentStatus, &c.ExtractedTextStatus, &c.DetectedColumnsText); err == nil {
			out = append(out, c)
		}
	}
	return out, rows.Err()
}

func parseDetectedColumns(raw string) parsedMetadata {
	var meta map[string]any
	_ = json.Unmarshal([]byte(raw), &meta)
	out := parsedMetadata{Parser: stringFrom(meta["parser"])}
	if columns, ok := meta["columns"].([]any); ok {
		for _, column := range columns {
			if text := stringFrom(column); text != "" {
				out.Columns = append(out.Columns, text)
			}
		}
	}
	if rows, ok := meta["parsedRows"].([]any); ok {
		for _, item := range rows {
			if row, ok := item.(map[string]any); ok {
				out.ParsedRows = append(out.ParsedRows, row)
			}
		}
	}
	return out
}

func normalizeSourceType(source string) string {
	key := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(source), "-", "_"))
	key = strings.ReplaceAll(key, " ", "_")
	switch key {
	case "bank", "bank_statement", "bankstatement":
		return "bank_statement"
	case "invoice", "invoices":
		return "invoices"
	case "tally", "tally_export", "tallyexport", "ledger", "ledger_entries":
		return "tally_export"
	case "zoho", "zoho_export":
		return "zoho_export"
	case "gst", "gst_tds", "gsttds":
		return "gst_tds"
	case "payroll":
		return "payroll"
	case "gateway", "gateway_settlement", "gatewaysettlement":
		return "gateway_settlement"
	case "expense", "expenses":
		return "expenses"
	default:
		return key
	}
}

func sourceTable(sourceType string) string {
	switch normalizeSourceType(sourceType) {
	case "bank_statement", "expenses":
		return "bank_transactions"
	case "invoices", "zoho_export":
		return "invoices"
	case "tally_export":
		return "ledger_entries"
	case "gst_tds":
		return "gst_records"
	case "payroll":
		return "payroll_entries"
	case "gateway_settlement":
		return "gateway_settlements"
	default:
		return ""
	}
}

func addImportCount(imported map[string]int, table string, n int) {
	switch table {
	case "bank_transactions":
		imported["bankTransactions"] += n
	case "invoices":
		imported["invoices"] += n
	case "ledger_entries":
		imported["ledgerEntries"] += n
	case "gst_records":
		imported["gstRecords"] += n
	case "payroll_entries":
		imported["payrollEntries"] += n
	case "gateway_settlements":
		imported["gatewaySettlements"] += n
	}
}

func ingestRows(r *http.Request, db *sql.DB, companyID int, sourceType string, fileName string, uploadID int, rows []map[string]any) (importSummary, error) {
	table := sourceTable(sourceType)
	if table == "" || len(rows) == 0 {
		return importSummary{Table: table, Skipped: len(rows), Notes: []string{"No importer is available for this source type yet."}}, nil
	}

	inserted := 0
	var err error
	switch {
	case table == "bank_transactions" && normalizeSourceType(sourceType) == "expenses":
		inserted, err = importExpenseRows(r, db, companyID, rows, uploadID)
	case table == "bank_transactions":
		inserted, err = importBankRows(r, db, companyID, rows, uploadID)
	case table == "invoices":
		inserted, err = importInvoiceRows(r, db, companyID, rows, sourceType, uploadID)
	case table == "ledger_entries":
		inserted, err = importLedgerRows(r, db, companyID, rows, uploadID)
	case table == "payroll_entries":
		inserted, err = importPayrollRows(r, db, companyID, rows, uploadID)
	case table == "gateway_settlements":
		inserted, err = importGatewayRows(r, db, companyID, rows, fileName, uploadID)
	case table == "gst_records":
		inserted, err = importGstRows(r, db, companyID, rows, uploadID)
	}
	if err != nil {
		return importSummary{Table: table, Skipped: len(rows)}, err
	}
	note := fmt.Sprintf("Imported %d rows into %s for rule-based reconciliation.", inserted, table)
	if inserted == 0 {
		note = fmt.Sprintf("No importable rows found for %s. Check required columns and try again.", table)
	}
	return importSummary{Table: table, Inserted: inserted, Skipped: len(rows) - inserted, Notes: []string{note}}, nil
}

func importBankRows(r *http.Request, db *sql.DB, companyID int, rows []map[string]any, uploadID int) (int, error) {
	inserted := 0
	for _, row := range rows {
		date := dateValue(row, []string{"date", "txn date", "transaction date", "value date", "posting date", "tran date", "booking date", "entry date", "value dt", "txn dt"})
		narration := value(row, []string{"narration", "description", "particulars", "details", "remarks", "transaction remarks", "transaction particulars", "transaction description", "beneficiary", "memo", "reference details"})
		credit := numberValue(row, []string{"credit", "credit amt", "credit amount", "deposit", "deposit amount", "paid in", "receipt", "receipts", "cr", "cr amount", "inflow", "money in", "amount credited"})
		debit := numberValue(row, []string{"debit", "debit amt", "debit amount", "withdrawal", "withdrawal amount", "paid out", "payment", "payments", "dr", "dr amount", "outflow", "money out", "amount debited", "charges"})
		signed := numberValue(row, []string{"amount", "transaction amount", "tran amount", "amt", "net amount"})
		amount := firstNumber(credit, debit, absPtr(signed))
		if date == "" || narration == "" || amount == nil || *amount == 0 {
			continue
		}
		txnType := "credit"
		if debit != nil && *debit > 0 || signed != nil && *signed < 0 {
			txnType = "debit"
		}
		bankName := nullString(value(row, []string{"bank", "bank name", "account", "account name", "account no", "a/c name"}))
		reference := nullString(value(row, []string{"reference", "ref", "ref no", "utr", "utr no", "cheque no", "transaction id", "txn id", "rrn", "neft ref", "imps ref"}))
		balance := value(row, []string{"balance", "closing balance", "available balance", "running balance", "bal"})
		note := "Imported from uploaded bank statement."
		if balance != "" {
			note = "Closing balance: " + balance
		}
		_, err := db.ExecContext(r.Context(),
			`INSERT INTO bank_transactions
			 (company_id, date, narration, amount, type, source, bank_name, reference, status, confidence_score, note, source_upload_id)
			 VALUES ($1,$2,$3,$4,$5,'bank',$6,$7,'unverified',50,$8,$9)`,
			companyID, date, narration, money(*amount), txnType, bankName, reference, note, uploadID)
		if err != nil {
			return inserted, err
		}
		inserted++
	}
	return inserted, nil
}

func importExpenseRows(r *http.Request, db *sql.DB, companyID int, rows []map[string]any, uploadID int) (int, error) {
	inserted := 0
	for _, row := range rows {
		date := dateValue(row, []string{"date", "expense date", "txn date", "transaction date", "voucher date", "payment date"})
		description := value(row, []string{"description", "expense", "particulars", "details", "narration", "remarks", "purpose", "head"})
		amount := numberValue(row, []string{"amount", "expense amount", "value", "cost", "debit", "amount inr", "total"})
		if date == "" || description == "" || amount == nil || *amount == 0 {
			continue
		}
		category := value(row, []string{"category", "type", "head", "expense category", "expense head"})
		reference := nullString(value(row, []string{"reference", "bill no", "receipt no", "invoice no", "voucher no", "ref"}))
		note := "Imported from expense sheet."
		if category != "" {
			note = "Expense category: " + category + ". Imported from expense sheet."
		}
		_, err := db.ExecContext(r.Context(),
			`INSERT INTO bank_transactions
			 (company_id, date, narration, amount, type, source, bank_name, reference, status, confidence_score, note, source_upload_id)
			 VALUES ($1,$2,$3,$4,'debit','expense',NULL,$5,'unverified',50,$6,$7)`,
			companyID, date, description, money(*amount), reference, note, uploadID)
		if err != nil {
			return inserted, err
		}
		inserted++
	}
	return inserted, nil
}

func importInvoiceRows(r *http.Request, db *sql.DB, companyID int, rows []map[string]any, sourceType string, uploadID int) (int, error) {
	inserted := 0
	for _, row := range rows {
		invoiceNumber := value(row, []string{"invoice number", "invoice no", "invoice", "inv no", "bill number", "bill no", "voucher number", "document number", "reference number"})
		date := dateValue(row, []string{"date", "invoice date", "bill date", "doc date", "document date", "transaction date", "voucher date"})
		vendorName := value(row, []string{"vendor", "vendor name", "supplier", "supplier name", "party", "party name", "customer", "customer name", "buyer", "buyer name", "name", "counterparty"})
		total := numberValue(row, []string{"total amount", "invoice amount", "amount", "gross amount", "total", "net amount", "bill amount", "taxable value", "value"})
		if invoiceNumber == "" || date == "" || vendorName == "" || total == nil || *total == 0 {
			continue
		}
		cgst := numberOrZero(numberValue(row, []string{"cgst", "cgst amount", "central gst"}))
		sgst := numberOrZero(numberValue(row, []string{"sgst", "sgst amount", "state gst"}))
		igst := numberOrZero(numberValue(row, []string{"igst", "igst amount", "integrated gst"}))
		gst := numberValue(row, []string{"gst", "tax", "tax amount", "gst amount", "total tax"})
		gstValue := cgst + sgst + igst
		if gst != nil {
			gstValue = *gst
		}
		typeRaw := strings.ToLower(value(row, []string{"type", "invoice type", "document type", "transaction type"}))
		invoiceType := "purchase"
		if strings.Contains(typeRaw, "sale") || strings.Contains(typeRaw, "outward") {
			invoiceType = "sales"
		}
		status := "pending_reconciliation"
		if normalizeSourceType(sourceType) == "invoices" {
			status = "unverified"
		}
		var gstAmount any = nil
		if gstValue > 0 {
			gstAmount = money(gstValue)
		}
		_, err := db.ExecContext(r.Context(),
			`INSERT INTO invoices
			 (company_id, invoice_number, vendor_name, customer_name, gstin, date, amount, gst_amount, type, payment_status, status, source_upload_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'unpaid',$10,$11)`,
			companyID, invoiceNumber, vendorName,
			nullString(value(row, []string{"customer", "customer name", "buyer", "buyer name", "to"})),
			nullString(value(row, []string{"gstin", "vendor gstin", "supplier gstin", "gst no", "gst number"})),
			date, money(*total), gstAmount, invoiceType, status, uploadID)
		if err != nil {
			return inserted, err
		}
		inserted++
	}
	return inserted, nil
}

func importLedgerRows(r *http.Request, db *sql.DB, companyID int, rows []map[string]any, uploadID int) (int, error) {
	inserted := 0
	for _, row := range rows {
		date := dateValue(row, []string{"date", "voucher date", "posting date", "txn date", "transaction date", "entry date", "doc date"})
		ledgerName := value(row, []string{"ledger", "ledger name", "account", "account name", "particulars", "party", "party name", "narration", "description", "details", "remarks", "name", "head"})
		debit := numberValue(row, []string{"debit", "dr", "dr amount", "debit amount", "debit amt"})
		credit := numberValue(row, []string{"credit", "cr", "cr amount", "credit amount", "credit amt"})
		amount := firstNumber(debit, credit, numberValue(row, []string{"amount", "voucher amount", "transaction amount", "value", "net amount"}))
		if date == "" || ledgerName == "" || amount == nil || *amount == 0 {
			continue
		}
		dcRaw := strings.ToLower(value(row, []string{"debit credit", "dr cr", "type", "nature", "dc"}))
		debitCredit := "credit"
		if debit != nil && *debit > 0 || strings.HasPrefix(dcRaw, "d") {
			debitCredit = "debit"
		}
		_, err := db.ExecContext(r.Context(),
			`INSERT INTO ledger_entries
			 (company_id, date, ledger_name, voucher_number, amount, debit_credit, source_tool, status, source_upload_id)
			 VALUES ($1,$2,$3,$4,$5,$6,'upload','unmatched',$7)`,
			companyID, date, ledgerName, nullString(value(row, []string{"voucher", "voucher no", "voucher number", "reference", "doc no", "ref no"})), money(*amount), debitCredit, uploadID)
		if err != nil {
			return inserted, err
		}
		inserted++
	}
	return inserted, nil
}

func importPayrollRows(r *http.Request, db *sql.DB, companyID int, rows []map[string]any, uploadID int) (int, error) {
	inserted := 0
	for _, row := range rows {
		employeeName := value(row, []string{"employee", "employee name", "name", "staff name", "emp name", "employee id", "emp id"})
		month := value(row, []string{"month", "pay month", "salary month", "period", "pay period", "month year", "payroll period"})
		net := numberValue(row, []string{"net amount", "net salary", "net pay", "take home", "net ctc", "amount", "paid amount", "net"})
		if employeeName == "" || month == "" || net == nil || *net == 0 {
			continue
		}
		var gross any = nil
		if v := numberValue(row, []string{"gross amount", "gross salary", "gross pay", "gross ctc", "ctc", "total earnings", "gross"}); v != nil {
			gross = money(*v)
		}
		_, err := db.ExecContext(r.Context(),
			`INSERT INTO payroll_entries
			 (company_id, employee_name, month, gross_amount, net_amount, payment_date, bank_reference, status, source_upload_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,'unverified',$8)`,
			companyID, employeeName, month, gross, money(*net), nullString(dateValue(row, []string{"payment date", "paid date", "date", "salary date", "disbursement date"})), nullString(value(row, []string{"bank reference", "reference", "utr", "neft ref", "transaction id"})), uploadID)
		if err != nil {
			return inserted, err
		}
		inserted++
	}
	return inserted, nil
}

func importGatewayRows(r *http.Request, db *sql.DB, companyID int, rows []map[string]any, fileName string, uploadID int) (int, error) {
	inserted := 0
	for _, row := range rows {
		settlementID := value(row, []string{"settlement id", "settlement_id", "id", "reference", "settlement number", "payout id", "transaction id", "transfer id", "batch id"})
		net := numberValue(row, []string{"net amount", "settled amount", "amount", "net", "payout amount", "settlement amount", "transfer amount"})
		settlementDate := dateValue(row, []string{"settlement date", "date", "paid date", "payout date", "settled date", "transfer date", "credit date"})
		if settlementID == "" || net == nil || *net == 0 || settlementDate == "" {
			continue
		}
		provider := value(row, []string{"provider", "gateway", "payment gateway"})
		if provider == "" {
			provider = providerFromFile(fileName)
		}
		gross := firstNumber(numberValue(row, []string{"gross amount", "gross", "total amount"}), net)
		fees := numberOrZero(numberValue(row, []string{"fees", "fee", "charges", "platform fee", "processing fee"}))
		var gstOnFees any = nil
		if v := numberValue(row, []string{"gst on fees", "tax on fees", "gst", "igst on fees"}); v != nil {
			gstOnFees = money(*v)
		}
		_, err := db.ExecContext(r.Context(),
			`INSERT INTO gateway_settlements
			 (company_id, provider, settlement_id, gross_amount, fees, gst_on_fees, net_amount, settlement_date, bank_reference, status, source_upload_id)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10)`,
			companyID, provider, settlementID, money(*gross), money(fees), gstOnFees, money(*net), settlementDate, nullString(value(row, []string{"bank reference", "utr", "reference", "neft ref"})), uploadID)
		if err != nil {
			return inserted, err
		}
		inserted++
	}
	return inserted, nil
}

func importGstRows(r *http.Request, db *sql.DB, companyID int, rows []map[string]any, uploadID int) (int, error) {
	inserted := 0
	for _, row := range rows {
		invoiceNumber := value(row, []string{"invoice number", "invoice no", "inum", "bill number", "doc no", "reference number"})
		period := value(row, []string{"period", "return period", "month", "tax period", "gstr period"})
		if period == "" {
			period = "Uploaded period"
		}
		taxable := numberOrZero(numberValue(row, []string{"taxable value", "taxable", "value", "assessable value"}))
		cgst := numberOrZero(numberValue(row, []string{"cgst", "central tax"}))
		sgst := numberOrZero(numberValue(row, []string{"sgst", "state tax", "ut tax"}))
		igst := numberOrZero(numberValue(row, []string{"igst", "integrated tax"}))
		gst := numberValue(row, []string{"gst", "tax", "igst", "cgst", "sgst", "gst amount", "total tax"})
		gstValue := cgst + sgst + igst
		if gst != nil {
			gstValue = *gst
		}
		if invoiceNumber == "" && taxable == 0 && gstValue == 0 {
			continue
		}
		_, err := db.ExecContext(r.Context(),
			`INSERT INTO gst_records
			 (company_id, period, source_type, gstin, counterparty_name, invoice_number, invoice_date, taxable_value, gst_amount, match_status, risk_status, source_upload_id)
			 VALUES ($1,$2,'uploaded_gst',$3,$4,$5,$6,$7,$8,'unmatched','none',$9)`,
			companyID, period, nullString(value(row, []string{"gstin", "counterparty gstin", "ctin", "supplier gstin"})), nullString(value(row, []string{"counterparty", "counterparty name", "supplier", "party name", "trade name"})), nullString(invoiceNumber), nullString(dateValue(row, []string{"invoice date", "date", "doc date"})), money(taxable), money(gstValue), uploadID)
		if err != nil {
			return inserted, err
		}
		inserted++
	}
	return inserted, nil
}

func value(row map[string]any, aliases []string) string {
	normalizedAliases := []string{}
	for _, alias := range aliases {
		if a := normalizeColumn(alias); len(a) >= 2 {
			normalizedAliases = append(normalizedAliases, a)
		}
	}
	for _, pass := range []int{1, 2, 3} {
		for key, raw := range row {
			k := normalizeColumn(key)
			if k == "" {
				continue
			}
			for _, alias := range normalizedAliases {
				match := pass == 1 && k == alias ||
					pass == 2 && len(alias) >= 3 && strings.Contains(k, alias) ||
					pass == 3 && len(k) >= 3 && strings.Contains(alias, k)
				if match {
					text := strings.TrimSpace(stringFrom(raw))
					if text != "" {
						return text
					}
				}
			}
		}
	}
	return ""
}

func normalizeColumn(key string) string {
	return regexp.MustCompile(`[^a-z0-9]+`).ReplaceAllString(strings.ToLower(key), "")
}

func stringFrom(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		if t == math.Trunc(t) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int:
		return strconv.Itoa(t)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprint(t)
	}
}

func numberValue(row map[string]any, aliases []string) *float64 {
	raw := value(row, aliases)
	if raw == "" {
		return nil
	}
	cleaned := strings.TrimSpace(raw)
	cleaned = strings.ReplaceAll(cleaned, ",", "")
	cleaned = strings.ReplaceAll(cleaned, " ", "")
	cleaned = regexp.MustCompile(`(?i)\bINR\b|\bRS\.?\b|\p{Sc}`).ReplaceAllString(cleaned, "")
	if strings.HasPrefix(cleaned, "(") && strings.HasSuffix(cleaned, ")") {
		cleaned = "-" + strings.TrimSuffix(strings.TrimPrefix(cleaned, "("), ")")
	}
	if cleaned == "" || cleaned == "-" {
		return nil
	}
	n, err := strconv.ParseFloat(cleaned, 64)
	if err != nil || math.IsNaN(n) || math.IsInf(n, 0) {
		return nil
	}
	return &n
}

func dateValue(row map[string]any, aliases []string) string {
	raw := value(row, aliases)
	if raw == "" {
		return ""
	}
	return parseDate(raw)
}

func parseDate(raw string) string {
	s := strings.TrimSpace(raw)
	if regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`).MatchString(s) {
		return s
	}
	if m := regexp.MustCompile(`^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$`).FindStringSubmatch(s); len(m) == 4 {
		day, _ := strconv.Atoi(m[1])
		month, _ := strconv.Atoi(m[2])
		year, _ := strconv.Atoi(m[3])
		if day >= 1 && day <= 31 && month >= 1 && month <= 12 {
			return fmt.Sprintf("%04d-%02d-%02d", year, month, day)
		}
	}
	if m := regexp.MustCompile(`^(\d{1,2})[\s\-/]([A-Za-z]{3})[\s\-/](\d{4})$`).FindStringSubmatch(s); len(m) == 4 {
		months := map[string]int{"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
		if month := months[strings.ToLower(m[2])]; month > 0 {
			day, _ := strconv.Atoi(m[1])
			year, _ := strconv.Atoi(m[3])
			return fmt.Sprintf("%04d-%02d-%02d", year, month, day)
		}
	}
	for _, layout := range []string{time.RFC3339, "2006/01/02", "02 Jan 2006", "02-Jan-2006", "Jan 02 2006"} {
		if parsed, err := time.Parse(layout, s); err == nil {
			return parsed.Format("2006-01-02")
		}
	}
	return s
}

func money(v float64) string {
	return fmt.Sprintf("%.2f", math.Abs(v))
}

func firstNumber(values ...*float64) *float64 {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}

func absPtr(v *float64) *float64 {
	if v == nil {
		return nil
	}
	x := math.Abs(*v)
	return &x
}

func numberOrZero(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

func nullString(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

func providerFromFile(fileName string) string {
	lower := strings.ToLower(fileName)
	for _, provider := range []string{"cashfree", "stripe", "razorpay", "payu", "paytm"} {
		if strings.Contains(lower, provider) {
			if provider == "payu" {
				return "PayU"
			}
			return strings.ToUpper(provider[:1]) + provider[1:]
		}
	}
	return "Gateway"
}
