package routes

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A fixed address under a wildcard route must reach the service that owns it. Before this was handled,
// GET /api/workflow/runs/suggest-name was answered by the run lookup (as run "suggest-name") with a 404.
func TestFixedAddressesUnderAWildcardReachTheFallback(t *testing.T) {
	mux := http.NewServeMux()
	fallback := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Header().Set("X-Fallback", "yes") })
	Mount(mux, &Authorizer{}, Protected(nil), fallback)

	for _, pattern := range ProxiedLiteralRoutes {
		method, path, _ := strings.Cut(pattern, " ")
		recorder := httptest.NewRecorder()
		mux.ServeHTTP(recorder, httptest.NewRequest(method, path, nil))
		if recorder.Header().Get("X-Fallback") != "yes" {
			t.Errorf("%s was not passed to the fallback (status %d)", path, recorder.Code)
		}
	}
	// And an address nobody owns also goes to the fallback.
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest("GET", "/api/anything-else", nil))
	if recorder.Header().Get("X-Fallback") != "yes" {
		t.Errorf("an unknown address was not passed to the fallback")
	}
}

// Every literal address in the list really does sit under a wildcard protected route (otherwise the entry is dead).
func TestEveryProxiedLiteralRouteIsUnderAProtectedWildcard(t *testing.T) {
	for _, pattern := range ProxiedLiteralRoutes {
		method, path, _ := strings.Cut(pattern, " ")
		shadowed := false
		for _, route := range Protected(nil) {
			if !strings.Contains(route.Pattern, "{") {
				continue
			}
			protectedMethod, protectedPath, _ := strings.Cut(route.Pattern, " ")
			prefix, _, _ := strings.Cut(protectedPath, "{")
			if protectedMethod == method && strings.HasPrefix(path, prefix) {
				shadowed = true
			}
		}
		if !shadowed {
			t.Errorf("%s is not under any protected wildcard route; remove it from ProxiedLiteralRoutes", pattern)
		}
	}
}
