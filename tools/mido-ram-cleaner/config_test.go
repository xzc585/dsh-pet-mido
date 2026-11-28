package main

import (
	"os"
	"strings"
	"testing"
)

func TestLoadLegacyConfigUsesDisplayAndNotificationDefaults(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	path, err := configPath()
	if err != nil {
		t.Fatal(err)
	}
	raw := []byte(`{"autoClean":false,"intervalSec":900,"thresholdPercent":75,"debounceSec":90}`)
	if err := os.WriteFile(path, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	got := loadConfig()
	if got.AutoClean || !got.ShowUsage || got.NotifyOnClean || got.IntervalSec != 900 ||
		got.ThresholdPercent != 75 || got.DebounceSec != 90 {
		t.Fatalf("legacy config not migrated: %+v", got)
	}
}

func TestConfigUpdatePreservesOmittedPreferences(t *testing.T) {
	t.Setenv("APPDATA", t.TempDir())
	cfg := defaultConfig()
	cfg.ShowUsage = false
	cfg.NotifyOnClean = true
	updated, err := decodeConfig(strings.NewReader(`{"autoClean":false,"intervalSec":900,"thresholdPercent":75,"debounceSec":90}`), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if updated.ShowUsage || !updated.NotifyOnClean || updated.AutoClean || updated.IntervalSec != 900 {
		t.Fatalf("old client lost saved preferences: %+v", updated)
	}
	updated, err = decodeConfig(strings.NewReader(`{"showUsage":true,"notifyOnClean":false}`), updated)
	if err != nil {
		t.Fatal(err)
	}
	if !updated.ShowUsage || updated.NotifyOnClean || updated.IntervalSec != 900 {
		t.Fatalf("explicit preferences were not saved independently: %+v", updated)
	}
	if _, err := decodeConfig(strings.NewReader("null"), updated); err == nil {
		t.Fatal("null accepted as a valid settings object")
	}
}
