package main

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

// Config is persisted under %APPDATA%/mido-ram-cleaner/config.json.
type Config struct {
	AutoClean        bool `json:"autoClean"`
	IntervalSec      int  `json:"intervalSec"`
	ThresholdPercent int  `json:"thresholdPercent"`
	DebounceSec      int  `json:"debounceSec"`
	ShowUsage        bool `json:"showUsage"`
	NotifyOnClean    bool `json:"notifyOnClean"`
}

func defaultConfig() Config {
	return Config{
		AutoClean:        true,
		IntervalSec:      1800,
		ThresholdPercent: 85,
		DebounceSec:      120,
		ShowUsage:        true,
	}
}

var errInvalidConfigJSON = errors.New("设置格式无效")

// Decode over the saved/default configuration so omitted fields retain their values.
func decodeConfig(body io.Reader, base Config) (Config, error) {
	cfg := &base
	decoder := json.NewDecoder(body)
	if err := decoder.Decode(&cfg); err != nil || cfg == nil {
		return Config{}, errInvalidConfigJSON
	}
	if err := validateConfig(*cfg); err != nil {
		return Config{}, err
	}
	return *cfg, nil
}

func validateConfig(c Config) error {
	if c.IntervalSec < 30 || c.IntervalSec > 86400 {
		return errors.New("定时间隔须在 30 到 86400 秒之间")
	}
	if c.ThresholdPercent < 50 || c.ThresholdPercent > 99 {
		return errors.New("占用阈值须在 50% 到 99% 之间")
	}
	if c.DebounceSec < 10 || c.DebounceSec > c.IntervalSec {
		return errors.New("最短间隔须不小于 10 秒，且不能大于定时间隔")
	}
	return nil
}

func appDir() (string, error) {
	base := os.Getenv("APPDATA")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, "AppData", "Roaming")
	}
	dir := filepath.Join(base, "mido-ram-cleaner")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, nil
}

func configPath() (string, error) {
	dir, err := appDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "config.json"), nil
}

func loadConfig() Config {
	cfg := defaultConfig()
	path, err := configPath()
	if err != nil {
		return cfg
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return cfg
	}
	parsed := cfg
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return cfg
	}
	if err := validateConfig(parsed); err != nil {
		return cfg
	}
	return parsed
}

func saveConfig(cfg Config) error {
	if err := validateConfig(cfg); err != nil {
		return err
	}
	path, err := configPath()
	if err != nil {
		return err
	}
	raw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	return writeStateFile(path, raw)
}

// Write into the same directory and publish only a complete JSON document.
func writeStateFile(path string, raw []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".mido-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, writeErr := file.Write(raw)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}
