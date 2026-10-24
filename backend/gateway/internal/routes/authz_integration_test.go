package routes

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"sort"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// These checks run the gateway's real sign-in and permission SQL against a real Postgres. The unit tests in
// authz_test.go replace the database with functions, so they cannot catch a wrong column name or a query that
// does not behave as intended. They run only when GATEWAY_TEST_DATABASE_URL names a database on THIS computer
// whose schema was made with `pnpm --filter @workspace/db run push`. Use a throwaway database: the test adds
// its own rows (one company with random names) and removes them afterwards. It refuses any other host.
const databaseEnv = "GATEWAY_TEST_DATABASE_URL"

func openThrowawayDatabase(t *testing.T) *sql.DB {
	t.Helper()
	raw := os.Getenv(databaseEnv)
	if raw == "" {
		t.Skipf("%s is not set: skipping the checks that need a real Postgres (see docs/TESTING.md)", databaseEnv)
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("%s is not a database address", databaseEnv)
	}
	switch parsed.Hostname() {
	case "localhost", "127.0.0.1", "::1":
	default:
		t.Fatalf("refusing to run: %s must point at a database on this computer, not %q", databaseEnv, parsed.Hostname())
	}
	db, err := sql.Open("pgx", raw)
	if err != nil {
		t.Fatalf("cannot open the test database: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		t.Fatalf("cannot reach the test database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("setup failed: %v\n%s", err, query)
	}
}

func mustInsert(t *testing.T, db *sql.DB, query string, args ...any) int {
	t.Helper()
	var id int
	if err := db.QueryRow(query, args...).Scan(&id); err != nil {
		t.Fatalf("setup failed: %v\n%s", err, query)
	}
	return id
}

func integrationToken(secret string, sid, sub, cid int, email, role string, expires time.Time) string {
	b64 := func(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{"sid": sid, "sub": sub, "cid": cid, "email": email, "role": role, "exp": expires.Unix()})
	unsigned := b64(header) + "." + b64(claims)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(unsigned))
	return unsigned + "." + b64(mac.Sum(nil))
}

func hashOfToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

type integrationWorld struct {
	db        *sql.DB
	secret    string
	companyID int
	handler   http.Handler
	paths     map[string]string // permission -> path
}

// person adds a user and a live session in the company and returns the bearer token.
func (w *integrationWorld) person(t *testing.T, companyID int, role string) (token string, userID, sessionID int) {
	t.Helper()
	email := fmt.Sprintf("%s-%d-%d@gateway-test.invalid", role, companyID, time.Now().UnixNano())
	userID = mustInsert(t, w.db, `INSERT INTO users (company_id, name, email, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, companyID, "Test "+role, email, role)
	sessionID = mustInsert(t, w.db, `INSERT INTO auth_sessions (user_id, company_id, token_hash, expires_at) VALUES ($1, $2, 'pending', NOW() + INTERVAL '1 hour') RETURNING id`, userID, companyID)
	token = integrationToken(w.secret, sessionID, userID, companyID, email, role, time.Now().Add(time.Hour))
	mustExec(t, w.db, `UPDATE auth_sessions SET token_hash = $1 WHERE id = $2`, hashOfToken(token), sessionID)
	return token, userID, sessionID
}

func (w *integrationWorld) status(permission, token string) int {
	req := httptest.NewRequest(http.MethodGet, w.paths[permission], nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	w.handler.ServeHTTP(rec, req)
	return rec.Code
}

func newIntegrationWorld(t *testing.T) (*integrationWorld, roleMatrix) {
	t.Helper()
	matrix, _ := loadRoleMatrix(t)
	db := openThrowawayDatabase(t)

	secret := fmt.Sprintf("integration-test-secret-%d-0123456789abcdef", time.Now().UnixNano())
	t.Setenv("JWT_SECRET", secret)
	t.Setenv("SESSION_SECRET", "")
	t.Setenv("APP_ENV", "")
	t.Setenv("NODE_ENV", "")

	w := &integrationWorld{db: db, secret: secret, paths: map[string]string{}}
	w.companyID = mustInsert(t, db, `INSERT INTO companies (name, industry) VALUES ($1, 'test') RETURNING id`, fmt.Sprintf("Gateway test %d", time.Now().UnixNano()))
	t.Cleanup(func() {
		for _, query := range []string{
			`DELETE FROM audit_logs WHERE company_id IN (SELECT id FROM companies WHERE name LIKE 'Gateway test %')`,
			`DELETE FROM auth_sessions WHERE company_id IN (SELECT id FROM companies WHERE name LIKE 'Gateway test %')`,
			`DELETE FROM role_permissions WHERE company_id IN (SELECT id FROM companies WHERE name LIKE 'Gateway test %')`,
			`DELETE FROM users WHERE company_id IN (SELECT id FROM companies WHERE name LIKE 'Gateway test %')`,
			`DELETE FROM companies WHERE name LIKE 'Gateway test %'`,
		} {
			_, _ = db.Exec(query)
		}
	})

	// The same rows the API creates for a new company (defaultRolePermissions), read from the API's own source.
	for role, permissions := range matrix {
		for permission := range permissions {
			mustExec(t, db, `INSERT INTO role_permissions (company_id, role, permission, enabled) VALUES ($1, $2, $3, true)`, w.companyID, role, permission)
		}
	}

	// One probe route per permission the real route table uses, so a route added later is covered too.
	ok := http.HandlerFunc(func(rw http.ResponseWriter, _ *http.Request) { rw.WriteHeader(http.StatusOK) })
	var probes []ProtectedRoute
	for _, route := range Protected(nil) {
		if _, seen := w.paths[route.Permission]; seen {
			continue
		}
		w.paths[route.Permission] = "/probe/" + route.Permission
		probes = append(probes, ProtectedRoute{Pattern: "GET /probe/" + route.Permission, Permission: route.Permission, Handler: ok})
	}
	mux := http.NewServeMux()
	Register(mux, NewAuthorizer(db), probes)
	w.handler = mux
	return w, matrix
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// Every role against every permission the gateway's routes use: allowed exactly where the API's role table allows.
func TestRealDatabaseGatewayAnswersEachRoleLikeTheAPI(t *testing.T) {
	w, matrix := newIntegrationWorld(t)
	if len(w.paths) < 5 {
		t.Fatalf("expected the route table to use several permissions, found %d", len(w.paths))
	}
	denied, allowed := 0, 0
	for _, role := range sortedKeys(matrix) {
		token, _, _ := w.person(t, w.companyID, role)
		t.Run(role, func(t *testing.T) {
			for _, permission := range sortedKeys(w.paths) {
				want := http.StatusForbidden
				if matrix[role][permission] {
					want = http.StatusOK
				}
				if got := w.status(permission, token); got != want {
					t.Errorf("%s asking for %s: got %d, want %d", role, permission, got, want)
				}
				if want == http.StatusOK {
					allowed++
				} else {
					denied++
				}
			}
		})
	}
	if denied == 0 || allowed == 0 {
		t.Fatalf("the matrix should contain both allowed and denied cases (allowed %d, denied %d)", allowed, denied)
	}
	t.Logf("checked %d allowed and %d denied role/permission pairs against the real database", allowed, denied)
}

// Anyone who is not properly signed in is turned away with 401, never reaching the permission check.
func TestRealDatabaseGatewayRefusesWhoIsNotSignedIn(t *testing.T) {
	w, _ := newIntegrationWorld(t)
	permission := sortedKeys(w.paths)[0]

	good, userID, sessionID := w.person(t, w.companyID, "founder")
	if got := w.status(permission, good); got != http.StatusOK {
		t.Fatalf("a founder with a live session should be let in, got %d", got)
	}
	if got := w.status(permission, ""); got != http.StatusUnauthorized {
		t.Errorf("no token: got %d, want 401", got)
	}
	if got := w.status(permission, "not-a-token"); got != http.StatusUnauthorized {
		t.Errorf("garbage token: got %d, want 401", got)
	}
	forged := integrationToken("some-other-secret-0123456789abcdef0123456789", sessionID, userID, w.companyID, "x@y.in", "founder", time.Now().Add(time.Hour))
	if got := w.status(permission, forged); got != http.StatusUnauthorized {
		t.Errorf("token signed with another secret: got %d, want 401", got)
	}
	// A correctly signed token whose hash is not the one stored for the session.
	reissued := integrationToken(w.secret, sessionID, userID, w.companyID, "x@y.in", "founder", time.Now().Add(2*time.Hour))
	if got := w.status(permission, reissued); got != http.StatusUnauthorized {
		t.Errorf("signed token that is not the session's own: got %d, want 401", got)
	}
	// Claims that name another company than the session belongs to.
	wrongCompany := integrationToken(w.secret, sessionID, userID, w.companyID+1000, "x@y.in", "founder", time.Now().Add(time.Hour))
	if got := w.status(permission, wrongCompany); got != http.StatusUnauthorized {
		t.Errorf("claims for another company: got %d, want 401", got)
	}

	mustExec(t, w.db, `UPDATE auth_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, sessionID)
	if got := w.status(permission, good); got != http.StatusUnauthorized {
		t.Errorf("expired session: got %d, want 401", got)
	}
	mustExec(t, w.db, `UPDATE auth_sessions SET expires_at = NOW() + INTERVAL '1 hour', revoked_at = NOW() WHERE id = $1`, sessionID)
	if got := w.status(permission, good); got != http.StatusUnauthorized {
		t.Errorf("revoked session: got %d, want 401", got)
	}
	mustExec(t, w.db, `UPDATE auth_sessions SET revoked_at = NULL WHERE id = $1`, sessionID)
	if got := w.status(permission, good); got != http.StatusOK {
		t.Fatalf("session restored: got %d, want 200", got)
	}
	mustExec(t, w.db, `UPDATE users SET status = 'disabled' WHERE id = $1`, userID)
	if got := w.status(permission, good); got != http.StatusUnauthorized {
		t.Errorf("disabled user: got %d, want 401", got)
	}
}

// Switching a permission off, having no rows at all, or holding another company's rows never lets anyone in,
// and each refusal leaves an audit row.
func TestRealDatabaseGatewayDeniesWithoutAPermissionRowAndRecordsIt(t *testing.T) {
	w, matrix := newIntegrationWorld(t)
	var permission string
	for _, candidate := range sortedKeys(w.paths) {
		if matrix["founder"][candidate] {
			permission = candidate
			break
		}
	}
	if permission == "" {
		t.Fatal("no permission found that the founder holds")
	}

	founder, _, _ := w.person(t, w.companyID, "founder")
	if got := w.status(permission, founder); got != http.StatusOK {
		t.Fatalf("founder should hold %s, got %d", permission, got)
	}
	mustExec(t, w.db, `UPDATE role_permissions SET enabled = false WHERE company_id = $1 AND role = 'founder' AND permission = $2`, w.companyID, permission)
	if got := w.status(permission, founder); got != http.StatusForbidden {
		t.Errorf("a switched-off permission: got %d, want 403", got)
	}

	stranger, strangerID, _ := w.person(t, w.companyID, "intern")
	for _, p := range sortedKeys(w.paths) {
		if got := w.status(p, stranger); got != http.StatusForbidden {
			t.Errorf("a role with no rows asking for %s: got %d, want 403", p, got)
		}
	}

	// Another company that gives the viewer role everything must not widen this company's viewer.
	otherCompany := mustInsert(t, w.db, `INSERT INTO companies (name, industry) VALUES ($1, 'test') RETURNING id`, fmt.Sprintf("Gateway test other %d", time.Now().UnixNano()))
	for p := range w.paths {
		mustExec(t, w.db, `INSERT INTO role_permissions (company_id, role, permission, enabled) VALUES ($1, 'viewer', $2, true)`, otherCompany, p)
	}
	viewer, _, _ := w.person(t, w.companyID, "viewer")
	for _, p := range sortedKeys(w.paths) {
		want := http.StatusForbidden
		if matrix["viewer"][p] {
			want = http.StatusOK
		}
		if got := w.status(p, viewer); got != want {
			t.Errorf("viewer asking for %s with another company's rows present: got %d, want %d", p, got, want)
		}
	}

	var count int
	var service, recordedPermission, entityType string
	err := w.db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE company_id = $1 AND user_id = $2 AND action = 'auth.permission_denied'`, w.companyID, strangerID).Scan(&count)
	if err != nil || count < len(w.paths) {
		t.Fatalf("expected an audit row for each refusal of the role with no rows (%d), found %d (err %v)", len(w.paths), count, err)
	}
	err = w.db.QueryRow(`SELECT entity_type, metadata->>'permission', metadata->>'service' FROM audit_logs WHERE company_id = $1 AND user_id = $2 AND action = 'auth.permission_denied' LIMIT 1`, w.companyID, strangerID).Scan(&entityType, &recordedPermission, &service)
	if err != nil {
		t.Fatalf("cannot read back the audit row: %v", err)
	}
	if entityType != "permission" || service != "gateway" || w.paths[recordedPermission] == "" {
		t.Errorf("audit row is incomplete: entity_type=%q permission=%q service=%q", entityType, recordedPermission, service)
	}
}
