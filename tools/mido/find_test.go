package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsPluginRoot(t *testing.T) {
	dir := t.TempDir()
	if isPluginRoot(dir) {
		t.Fatal("empty dir should not be a plugin root")
	}
	if err := os.Mkdir(filepath.Join(dir, "lib"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "lib", "app.js"), []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !isPluginRoot(dir) {
		t.Fatal("expected plugin root")
	}
}

func TestFilteredEnvDropsNodeMode(t *testing.T) {
	t.Setenv("ELECTRON_RUN_AS_NODE", "1")
	for _, kv := range filteredEnv() {
		if len(kv) >= 20 && kv[:20] == "ELECTRON_RUN_AS_NODE" {
			t.Fatalf("ELECTRON_RUN_AS_NODE should have been removed: %s", kv)
		}
	}
}
