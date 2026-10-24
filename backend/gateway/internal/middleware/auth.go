// Package middleware provides shared HTTP auth helpers for the Go API gateway.
package middleware

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

// jwtClaims are the fields we read from the FinVerify JWT.
type jwtClaims struct {
	Sid   int    `json:"sid"`
	Sub   int    `json:"sub"`
	Cid   int    `json:"cid"`
	Email string `json:"email"`
	Role  string `json:"role"`
	Exp   int64  `json:"exp"`
}

type AuthContext struct {
	UserID    int
	CompanyID int
	SessionID int
	Email     string
	Role      string
}

type authContextKey struct{}

// WithAuth records a sign-in that has already been checked, so the handler behind a permission
// check does not repeat the database lookup. Only code inside this process can set it.
func WithAuth(ctx context.Context, auth AuthContext) context.Context {
	return context.WithValue(ctx, authContextKey{}, auth)
}

// ExtractCompanyID returns the company ID from a verified FinVerify bearer JWT.
func ExtractCompanyID(r *http.Request) string {
	claims, ok := ExtractVerifiedClaims(r)
	if !ok || claims.Cid == 0 {
		return ""
	}
	return strconv.Itoa(claims.Cid)
}

// BooksCompany returns the company whose books this request may read or write.
// The signed-in company is the default. A linked client is allowed through
// ?client=, ?clientId=, or X-Client-Company-Id.
func BooksCompany(db *sql.DB, w http.ResponseWriter, r *http.Request, auth AuthContext) (int, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("client"))
	if raw == "" {
		raw = strings.TrimSpace(r.URL.Query().Get("clientId"))
	}
	if raw == "" {
		raw = strings.TrimSpace(r.Header.Get("X-Client-Company-Id"))
	}
	if raw == "" || raw == "null" || raw == "undefined" {
		return auth.CompanyID, true
	}
	clientID, err := strconv.Atoi(raw)
	if err != nil || clientID <= 0 {
		writeClientScopeError(w, http.StatusBadRequest, "invalid client id")
		return 0, false
	}
	if clientID == auth.CompanyID {
		return auth.CompanyID, true
	}
	var one int
	err = db.QueryRowContext(r.Context(),
		`SELECT 1 FROM ca_client_links WHERE ca_user_id = $1 AND client_company_id = $2 AND status = 'active' LIMIT 1`,
		auth.UserID, clientID).Scan(&one)
	if err != nil {
		writeClientScopeError(w, http.StatusForbidden, "Not authorised for this client")
		return 0, false
	}
	return clientID, true
}

func writeClientScopeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"ok":false,"error":"` + message + `"}`))
}

// AuthenticateRequest verifies the JWT and checks the backing DB session/user.
func AuthenticateRequest(db *sql.DB, r *http.Request) (AuthContext, bool) {
	if auth, ok := r.Context().Value(authContextKey{}).(AuthContext); ok {
		return auth, true
	}
	token := bearerToken(r)
	if token == "" {
		return AuthContext{}, false
	}

	claims, ok := verifyToken(token)
	if !ok {
		return AuthContext{}, false
	}

	hashBytes := sha256.Sum256([]byte(token))
	tokenHash := hex.EncodeToString(hashBytes[:])

	var auth AuthContext
	err := db.QueryRowContext(r.Context(),
		`SELECT u.id, u.company_id, s.id, u.email, u.role
		 FROM auth_sessions s
		 JOIN users u ON u.id = s.user_id
		 WHERE s.id = $1
		   AND s.user_id = $2
		   AND s.company_id = $3
		   AND s.token_hash = $4
		   AND s.expires_at > NOW()
		   AND s.revoked_at IS NULL
		   AND u.status = 'active'`,
		claims.Sid, claims.Sub, claims.Cid, tokenHash).
		Scan(&auth.UserID, &auth.CompanyID, &auth.SessionID, &auth.Email, &auth.Role)
	if err != nil {
		return AuthContext{}, false
	}

	return auth, true
}

// ExtractVerifiedClaims verifies the Authorization bearer JWT with the same
// HS256 signing scheme used by the TypeScript fallback.
func ExtractVerifiedClaims(r *http.Request) (jwtClaims, bool) {
	return verifyToken(bearerToken(r))
}

func bearerToken(r *http.Request) string {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return ""
	}
	return strings.TrimPrefix(auth, "Bearer ")
}

func verifyToken(token string) (jwtClaims, bool) {
	if token == "" {
		return jwtClaims{}, false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return jwtClaims{}, false
	}

	// No usable signing key means no token can be trusted. Never sign or check with an empty key.
	secret, err := SigningSecret()
	if err != nil {
		return jwtClaims{}, false
	}
	unsigned := parts[0] + "." + parts[1]
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(unsigned))
	expectedSignature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(parts[2]), []byte(expectedSignature)) {
		return jwtClaims{}, false
	}

	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return jwtClaims{}, false
	}

	var claims jwtClaims
	if err := json.Unmarshal(raw, &claims); err != nil || claims.Cid == 0 {
		return jwtClaims{}, false
	}
	if claims.Exp == 0 || claims.Exp < time.Now().Unix() {
		return jwtClaims{}, false
	}

	return claims, true
}

// developmentSecret is published in this repository. It is only ever used on a developer machine.
const developmentSecret = "finverify-dev-session-secret-change-me"

// sampleSecret is the placeholder in .env.example. It is longer than the minimum, so length alone
// would not catch a copied .env.example.
const sampleSecret = "replace-with-a-long-random-secret"

const minProductionSecretLength = 32

// IsProduction reports whether this process is a production service.
func IsProduction() bool {
	for _, key := range []string{"APP_ENV", "NODE_ENV"} {
		if strings.EqualFold(strings.TrimSpace(os.Getenv(key)), "production") {
			return true
		}
	}
	return false
}

// SigningSecret is the key sessions are signed with. A developer machine may run without one;
// production may not: it needs a real key of at least 32 characters that is not the published
// development value, otherwise anyone could sign their own session token.
func SigningSecret() (string, error) {
	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		secret = os.Getenv("SESSION_SECRET")
	}
	if !IsProduction() {
		if secret == "" {
			return developmentSecret, nil
		}
		return secret, nil
	}
	if secret == "" {
		return "", errors.New("JWT_SECRET or SESSION_SECRET must be set in production")
	}
	if secret == developmentSecret || secret == sampleSecret || len(secret) < minProductionSecretLength {
		return "", errors.New("the production signing secret must be at least 32 characters and not a value published in this repository")
	}
	return secret, nil
}
