package routes

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"net/http"

	"github.com/finverify/api-go/internal/middleware"
)

// Authorizer decides whether the signed-in person may use a route.
//
// The Express API is the source of truth for roles: backend/api/src/services/permissions.ts lists the
// permissions and the role_permissions table says which role holds which. This gateway reads the same
// table and applies the same rule as Express's requirePermission, so a route answers the same way
// whichever service receives the request.
type Authorizer struct {
	authenticate func(r *http.Request) (middleware.AuthContext, bool)
	allowed      func(ctx context.Context, companyID int, role, permission string) (bool, error)
	denied       func(ctx context.Context, auth middleware.AuthContext, permission string, r *http.Request)
}

// NewAuthorizer checks sessions and roles against the database.
func NewAuthorizer(db *sql.DB) *Authorizer {
	return &Authorizer{
		authenticate: func(r *http.Request) (middleware.AuthContext, bool) {
			return middleware.AuthenticateRequest(db, r)
		},
		allowed: func(ctx context.Context, companyID int, role, permission string) (bool, error) {
			var one int
			err := db.QueryRowContext(ctx,
				`SELECT 1 FROM role_permissions
				 WHERE company_id = $1 AND role = $2 AND permission = $3 AND enabled = true
				 LIMIT 1`,
				companyID, role, permission).Scan(&one)
			if err == sql.ErrNoRows {
				return false, nil
			}
			return err == nil, err
		},
		denied: func(ctx context.Context, auth middleware.AuthContext, permission string, r *http.Request) {
			writeAuditLog(ctx, db, auth.CompanyID, &auth.UserID, auth.Email, "auth.permission_denied", "permission", nil,
				map[string]any{"permission": permission, "role": auth.Role, "path": r.URL.Path, "method": r.Method, "service": "gateway"},
				r.RemoteAddr)
		},
	}
}

// Require runs next only for a signed-in person whose role holds the permission.
// No sign-in is 401, a missing permission is 403, and a failed lookup is refused too (never allowed).
func (a *Authorizer) Require(permission string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth, ok := a.authenticate(r)
		if !ok {
			errorJSON(w, http.StatusUnauthorized, "Authentication required")
			return
		}
		allowed, err := a.allowed(r.Context(), auth.CompanyID, auth.Role, permission)
		if err != nil {
			log.Printf("[authz] permission lookup failed for %s: %v", permission, err)
			errorJSON(w, http.StatusInternalServerError, "Permission check failed")
			return
		}
		if !allowed {
			a.denied(r.Context(), auth, permission, r)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusForbidden)
			_, _ = fmt.Fprintf(w, `{"error":"Permission denied","permission":%q}`, permission)
			return
		}
		next.ServeHTTP(w, r.WithContext(middleware.WithAuth(r.Context(), auth)))
	})
}
