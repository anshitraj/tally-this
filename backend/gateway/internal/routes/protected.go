package routes

import (
	"database/sql"
	"net/http"
)

// Permission names. They must exist in ALL_PERMISSIONS in backend/api/src/services/permissions.ts;
// a test reads that file and fails when one does not.
const (
	PermUploadsRead           = "uploads.read"
	PermUploadsCreate         = "uploads.create"
	PermReconciliationRead    = "reconciliation.read"
	PermReconciliationRun     = "reconciliation.run"
	PermReconciliationApprove = "reconciliation.approve"
	PermReconciliationReject  = "reconciliation.reject"
)

// ProtectedRoute is a route that needs a signed-in person who holds Permission.
// There is deliberately no way to add one without naming the permission.
type ProtectedRoute struct {
	Pattern    string
	Permission string
	Handler    http.Handler
}

// Protected lists every route the gateway answers itself except health. Each carries the same
// permission the Express API requires for the same path (see the routes in
// backend/api/src/routes/reconciliation.ts, monthlyClose.ts and actionHistory.ts).
func Protected(db *sql.DB) []ProtectedRoute {
	return []ProtectedRoute{
		{"GET /api/workflow/runs", PermUploadsRead, ListWorkflowRuns(db)},
		{"GET /api/workflow/runs/{id}", PermUploadsRead, GetWorkflowRun(db)},
		{"GET /api/workflow/runs/{id}/progress", PermUploadsRead, GetWorkflowRunProgress(db)},
		{"GET /api/action-history", PermUploadsRead, ListActionHistory(db)},

		{"POST /api/uploads/import-selected-sources", PermUploadsCreate, ImportSelectedSources(db)},
		{"POST /api/uploads/import-all-parsed", PermUploadsCreate, ImportAllParsed(db)},

		{"GET /api/reconciliation/runs", PermReconciliationRead, ListReconciliationFolders(db)},
		{"GET /api/reconciliation", PermReconciliationRead, ListReconciliationMatches(db)},
		{"POST /api/reconciliation/preflight", PermReconciliationRead, ReconciliationPreflight(db)},
		{"POST /api/reconciliation/run", PermReconciliationRun, RunReconciliation(db)},
		{"GET /api/reconciliation/run", PermReconciliationRun, RunReconciliation(db)},
		{"POST /api/reconciliation/{id}/approve", PermReconciliationApprove, UpdateReconciliationMatch(db, "approved")},
		{"POST /api/reconciliation/{id}/reject", PermReconciliationReject, UpdateReconciliationMatch(db, "rejected")},
		{"POST /api/reconciliation/{id}/needs-info", PermReconciliationApprove, UpdateReconciliationMatch(db, "needs_info")},
		{"POST /api/reconciliation/{id}/send-to-ca", PermReconciliationApprove, SendMatchToCA(db)},
	}
}

// ProxiedLiteralRoutes are fixed addresses that sit under a protected route with a wildcard
// (GET /api/workflow/runs/{id} would otherwise take "suggest-name" for a run id and answer 404).
// They go to the TypeScript API, which owns them and checks the permission itself.
var ProxiedLiteralRoutes = []string{
	"GET /api/workflow/runs/suggest-name",
}

// Register adds every protected route to the mux behind the authorizer.
func Register(mux *http.ServeMux, authz *Authorizer, routes []ProtectedRoute) {
	for _, route := range routes {
		mux.Handle(route.Pattern, authz.Require(route.Permission, route.Handler))
	}
}

// Mount puts everything the gateway serves on the mux: the protected routes behind the authorizer, the fixed
// addresses that belong to the fallback, and the fallback itself for every other address.
func Mount(mux *http.ServeMux, authz *Authorizer, protected []ProtectedRoute, fallback http.Handler) {
	Register(mux, authz, protected)
	for _, pattern := range ProxiedLiteralRoutes {
		mux.Handle(pattern, fallback)
	}
	mux.Handle("/", fallback)
}
