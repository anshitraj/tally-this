package config

import (
	"os"
	"strconv"
)

// Config holds all runtime configuration for the Go API gateway.
type Config struct {
	GoAPIPort        string
	TypeScriptAPIURL string
	PythonWorkerURL  string
	DatabaseURL      string
	JWTSecret        string
}

// Load reads environment variables. Call after godotenv.Load().
func Load() *Config {
	return &Config{
		GoAPIPort:        getEnv("GO_API_PORT", getEnv("PORT", "8090")),
		TypeScriptAPIURL: getEnv("TYPESCRIPT_API_URL", "http://localhost:8080"),
		PythonWorkerURL:  getEnv("PYTHON_WORKER_URL", "http://localhost:8091"),
		DatabaseURL:      getEnv("DATABASE_URL", ""),
		JWTSecret:        getEnv("JWT_SECRET", ""),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}
