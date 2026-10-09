package config

import "testing"

func TestRailwayPortAndLocalOverride(t *testing.T) {
	t.Setenv("PORT", "43210")
	t.Setenv("GO_API_PORT", "")
	if got := Load().GoAPIPort; got != "43210" {
		t.Fatalf("Railway PORT: got %q, want 43210", got)
	}
	t.Setenv("GO_API_PORT", "8090")
	if got := Load().GoAPIPort; got != "8090" {
		t.Fatalf("local gateway override: got %q, want 8090", got)
	}
}
