// Package proxy reverse-proxies unimplemented routes to the TypeScript fallback.
package proxy

import (
	"context"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
)

// New returns a reverse proxy handler pointing at targetURL (e.g. http://localhost:8080).
// Any route forwarded here is transparently proxied; the frontend sees no difference.
// An ErrorHandler is attached so that cancelled requests (browser navigates away)
// are absorbed silently and never crash the gateway process.
func New(targetURL string) http.Handler {
	target, err := url.Parse(targetURL)
	if err != nil {
		panic("invalid TYPESCRIPT_API_URL: " + targetURL)
	}
	rp := httputil.NewSingleHostReverseProxy(target)

	// Suppress context-cancelled errors (client disconnected) — these are normal
	// browser behaviour when the user navigates away before the response arrives.
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, proxyErr error) {
		if proxyErr == nil {
			return
		}
		// context.Canceled / context.DeadlineExceeded = client gone; not a real error.
		if proxyErr == context.Canceled || proxyErr == context.DeadlineExceeded {
			return
		}
		// For all other upstream errors, log and return 502.
		log.Printf("[proxy] upstream error for %s %s: %v", r.Method, r.URL.Path, proxyErr)
		http.Error(w, "upstream error", http.StatusBadGateway)
	}

	return rp
}
