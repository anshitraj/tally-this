package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const strongSecret = "a-long-random-production-secret-0123456789abcdef"

func clearSecrets(t *testing.T) {
	t.Helper()
	t.Setenv("JWT_SECRET", "")
	t.Setenv("SESSION_SECRET", "")
	t.Setenv("APP_ENV", "")
	t.Setenv("NODE_ENV", "")
}

// signedToken makes a session token the way the TypeScript API does (HS256).
func signedToken(t *testing.T, secret string, expiresIn time.Duration) string {
	t.Helper()
	b64 := func(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
	header, _ := json.Marshal(map[string]string{"alg": "HS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{"sid": 1, "sub": 2, "cid": 3, "email": "a@b.in", "role": "founder", "exp": time.Now().Add(expiresIn).Unix()})
	unsigned := b64(header) + "." + b64(claims)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(unsigned))
	return unsigned + "." + b64(mac.Sum(nil))
}

func TestProductionRefusesToRunWithoutASigningSecret(t *testing.T) {
	clearSecrets(t)
	for _, env := range []string{"APP_ENV", "NODE_ENV"} {
		t.Run(env, func(t *testing.T) {
			clearSecrets(t)
			t.Setenv(env, "production")
			if _, err := SigningSecret(); err == nil {
				t.Fatalf("%s=production with no secret must be an error", env)
			}
		})
	}
}

func TestProductionRefusesTheDevelopmentAndShortSecrets(t *testing.T) {
	for name, secret := range map[string]string{
		"the published development value": developmentSecret,
		"a short secret":                  "short-secret",
		"31 characters":                   strings.Repeat("x", 31),
	} {
		t.Run(name, func(t *testing.T) {
			clearSecrets(t)
			t.Setenv("APP_ENV", "production")
			t.Setenv("JWT_SECRET", secret)
			if _, err := SigningSecret(); err == nil {
				t.Fatalf("production must refuse %s", name)
			}
		})
	}
}

func TestProductionAcceptsAStrongSecretFromEitherVariable(t *testing.T) {
	for _, variable := range []string{"JWT_SECRET", "SESSION_SECRET"} {
		clearSecrets(t)
		t.Setenv("NODE_ENV", "production")
		t.Setenv(variable, strongSecret)
		got, err := SigningSecret()
		if err != nil || got != strongSecret {
			t.Fatalf("%s: got %q, %v", variable, got, err)
		}
	}
}

func TestADeveloperMachineMayUseTheDevelopmentSecret(t *testing.T) {
	clearSecrets(t)
	got, err := SigningSecret()
	if err != nil || got != developmentSecret {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestTokenSignedWithThePublishedSecretIsRefusedInProduction(t *testing.T) {
	forged := signedToken(t, developmentSecret, time.Hour)

	// A production service that lost its secret must trust nothing.
	clearSecrets(t)
	t.Setenv("APP_ENV", "production")
	if _, ok := verifyToken(forged); ok {
		t.Fatal("a token signed with the published development secret was accepted with no secret configured")
	}

	// And with a real secret configured, the forged token is simply wrong.
	t.Setenv("JWT_SECRET", strongSecret)
	if _, ok := verifyToken(forged); ok {
		t.Fatal("a token signed with the published development secret was accepted in production")
	}
}

func TestATokenSignedWithTheRealSecretStillWorks(t *testing.T) {
	clearSecrets(t)
	t.Setenv("APP_ENV", "production")
	t.Setenv("JWT_SECRET", strongSecret)
	if claims, ok := verifyToken(signedToken(t, strongSecret, time.Hour)); !ok || claims.Cid != 3 {
		t.Fatalf("a correctly signed token was refused: %+v %v", claims, ok)
	}
	if _, ok := verifyToken(signedToken(t, strongSecret, -time.Minute)); ok {
		t.Fatal("an expired token was accepted")
	}
	if _, ok := verifyToken(signedToken(t, strongSecret+"x", time.Hour)); ok {
		t.Fatal("a token signed with a different secret was accepted")
	}
}

func TestAHandlerBehindTheCheckSeesTheCheckedSignIn(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, ok := AuthenticateRequest(nil, req); ok {
		t.Fatal("a request with no token and no checked sign-in must not be authenticated")
	}
	want := AuthContext{UserID: 1, CompanyID: 2, SessionID: 3, Email: "x@y.in", Role: "ca"}
	req = req.WithContext(WithAuth(req.Context(), want))
	got, ok := AuthenticateRequest(nil, req)
	if !ok || got != want {
		t.Fatalf("got %+v, %v", got, ok)
	}
}
