package routes

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/finverify/api-go/internal/middleware"
)

// The role table is read from the TypeScript API's own source, so the two services cannot drift apart
// without a test failing.
const permissionsFile = "../../../api/src/services/permissions.ts"

type roleMatrix map[string]map[string]bool

func loadRoleMatrix(t *testing.T) (roleMatrix, map[string]bool) {
	t.Helper()
	raw, err := os.ReadFile(permissionsFile)
	if err != nil {
		t.Skipf("permissions.ts not found (%v): the gateway is being tested outside the monorepo", err)
	}
	src := string(raw)
	list := func(name string) []string {
		block := regexp.MustCompile(`(?s)` + name + `\s*=\s*\[(.*?)\]\s*as const`).FindStringSubmatch(src)
		if block == nil {
			t.Fatalf("could not find %s in permissions.ts", name)
		}
		var out []string
		for _, quoted := range regexp.MustCompile(`"([a-z_]+\.[a-z_]+)"`).FindAllStringSubmatch(block[1], -1) {
			out = append(out, quoted[1])
		}
		if len(out) == 0 {
			t.Fatalf("%s is empty in permissions.ts", name)
		}
		return out
	}
	set := func(items []string) map[string]bool {
		m := map[string]bool{}
		for _, item := range items {
			m[item] = true
		}
		return m
	}
	all := list("ALL_PERMISSIONS")
	return roleMatrix{
		"founder": set(all),
		"admin":   set(all),
		"ca":      set(list("CA_PERMISSIONS")),
		"finance": set(list("FINANCE_TEAM_PERMISSIONS")),
		"viewer":  set(list("VIEWER_PERMISSIONS")),
	}, set(all)
}

type attempt struct {
	status  int
	reached bool
	denied  []string
}

// harness builds the real route table behind a fake authorizer. Every handler is replaced by a
// sentinel, so the test can see whether a request got past the permission check.
type harness struct {
	t       *testing.T
	mux     *http.ServeMux
	routes  []ProtectedRoute
	reached *bool
	denied  *[]string
}

func newHarness(t *testing.T, role string, matrix roleMatrix, lookupErr error) *harness {
	t.Helper()
	reached := false
	denied := []string{}
	authz := &Authorizer{
		authenticate: func(r *http.Request) (middleware.AuthContext, bool) {
			if r.Header.Get("Authorization") == "" {
				return middleware.AuthContext{}, false
			}
			return middleware.AuthContext{UserID: 7, CompanyID: 3, SessionID: 1, Email: "person@example.com", Role: role}, true
		},
		allowed: func(_ context.Context, _ int, role, permission string) (bool, error) {
			if lookupErr != nil {
				return false, lookupErr
			}
			return matrix[role][permission], nil
		},
		denied: func(_ context.Context, _ middleware.AuthContext, permission string, _ *http.Request) {
			denied = append(denied, permission)
		},
	}
	sentinel := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		// The handler behind the check must see the sign-in that was already verified (db is nil here,
		// so a second database lookup would fail).
		if _, ok := middleware.AuthenticateRequest(nil, r); !ok {
			http.Error(w, "sign-in not carried through", http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	})
	routes := Protected(nil)
	for i := range routes {
		routes[i].Handler = sentinel
	}
	mux := http.NewServeMux()
	Register(mux, authz, routes)
	return &harness{t: t, mux: mux, routes: routes, reached: &reached, denied: &denied}
}

func (h *harness) call(route ProtectedRoute, signedIn bool) attempt {
	*h.reached = false
	*h.denied = nil
	parts := strings.SplitN(route.Pattern, " ", 2)
	path := strings.ReplaceAll(parts[1], "{id}", "5")
	req := httptest.NewRequest(parts[0], path, nil)
	if signedIn {
		req.Header.Set("Authorization", "Bearer token-checked-by-the-fake")
	}
	rec := httptest.NewRecorder()
	h.mux.ServeHTTP(rec, req)
	return attempt{status: rec.Code, reached: *h.reached, denied: append([]string(nil), *h.denied...)}
}

func TestEveryProtectedRouteNamesAPermissionThatExists(t *testing.T) {
	_, known := loadRoleMatrix(t)
	seen := map[string]bool{}
	for _, route := range Protected(nil) {
		if route.Permission == "" {
			t.Errorf("%s has no permission", route.Pattern)
		}
		if !known[route.Permission] {
			t.Errorf("%s names %q, which is not in ALL_PERMISSIONS in permissions.ts", route.Pattern, route.Permission)
		}
		if !regexp.MustCompile(`^(GET|POST) /api/`).MatchString(route.Pattern) {
			t.Errorf("unexpected route pattern %q", route.Pattern)
		}
		if seen[route.Pattern] {
			t.Errorf("%s is listed twice", route.Pattern)
		}
		seen[route.Pattern] = true
	}
	if len(seen) != 15 {
		t.Errorf("expected 15 protected routes, found %d: update this count only after checking the new route's permission", len(seen))
	}
}

func TestNothingIsRegisteredOutsideTheProtectedTable(t *testing.T) {
	raw, err := os.ReadFile("../../cmd/api/main.go")
	if err != nil {
		t.Skipf("main.go not found: %v", err)
	}
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "mux.Handle") {
			continue
		}
		if strings.Contains(trimmed, "/api/health") || strings.Contains(trimmed, `"/", tsProxy`) {
			continue
		}
		t.Errorf("main.go registers a route outside routes.Protected: %s", trimmed)
	}
}

func TestWithoutSignInEveryProtectedRouteIsRefused(t *testing.T) {
	matrix, _ := loadRoleMatrix(t)
	h := newHarness(t, "founder", matrix, nil)
	for _, route := range h.routes {
		got := h.call(route, false)
		if got.status != http.StatusUnauthorized || got.reached {
			t.Errorf("%s without sign-in: status %d, handler reached %v (want 401, not reached)", route.Pattern, got.status, got.reached)
		}
	}
}

func TestEachRoleCanOnlyDoWhatThePermissionTableGivesIt(t *testing.T) {
	matrix, _ := loadRoleMatrix(t)
	for role := range matrix {
		h := newHarness(t, role, matrix, nil)
		for _, route := range h.routes {
			want := matrix[role][route.Permission]
			got := h.call(route, true)
			if want && (got.status != http.StatusOK || !got.reached) {
				t.Errorf("%s may use %s but got status %d (reached %v)", role, route.Pattern, got.status, got.reached)
			}
			if !want {
				if got.status != http.StatusForbidden || got.reached {
					t.Errorf("%s must NOT use %s but got status %d (reached %v)", role, route.Pattern, got.status, got.reached)
				}
				if len(got.denied) != 1 || got.denied[0] != route.Permission {
					t.Errorf("%s on %s: the refusal was not audited as %q (got %v)", role, route.Pattern, route.Permission, got.denied)
				}
			}
		}
	}
}

func TestAViewerCannotChangeAnything(t *testing.T) {
	matrix, _ := loadRoleMatrix(t)
	h := newHarness(t, "viewer", matrix, nil)
	forbidden := map[string]bool{
		"POST /api/uploads/import-selected-sources": true,
		"POST /api/uploads/import-all-parsed":       true,
		"POST /api/reconciliation/run":              true,
		"GET /api/reconciliation/run":               true,
		"POST /api/reconciliation/{id}/approve":     true,
		"POST /api/reconciliation/{id}/reject":      true,
		"POST /api/reconciliation/{id}/needs-info":  true,
		"POST /api/reconciliation/{id}/send-to-ca":  true,
	}
	checked := 0
	for _, route := range h.routes {
		got := h.call(route, true)
		if forbidden[route.Pattern] {
			checked++
			if got.status != http.StatusForbidden || got.reached {
				t.Errorf("a viewer got through to %s (status %d)", route.Pattern, got.status)
			}
		}
	}
	if checked != len(forbidden) {
		t.Fatalf("only %d of %d must-refuse routes were found; the route table changed", checked, len(forbidden))
	}
}

func TestFinanceCanRunReconciliationButNotApproveOrReject(t *testing.T) {
	matrix, _ := loadRoleMatrix(t)
	h := newHarness(t, "finance", matrix, nil)
	byPattern := map[string]ProtectedRoute{}
	for _, route := range h.routes {
		byPattern[route.Pattern] = route
	}
	if got := h.call(byPattern["POST /api/reconciliation/run"], true); got.status != http.StatusOK {
		t.Errorf("finance should be able to run reconciliation, got %d", got.status)
	}
	for _, pattern := range []string{"POST /api/reconciliation/{id}/approve", "POST /api/reconciliation/{id}/reject"} {
		if got := h.call(byPattern[pattern], true); got.status != http.StatusForbidden || got.reached {
			t.Errorf("finance must not use %s (status %d)", pattern, got.status)
		}
	}
}

func TestAFailedPermissionLookupRefusesInsteadOfAllowing(t *testing.T) {
	matrix, _ := loadRoleMatrix(t)
	h := newHarness(t, "founder", matrix, errors.New("database unavailable"))
	for _, route := range h.routes {
		got := h.call(route, true)
		if got.status != http.StatusInternalServerError || got.reached {
			t.Errorf("%s with a broken lookup: status %d, reached %v (want 500, not reached)", route.Pattern, got.status, got.reached)
		}
	}
}
