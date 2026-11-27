package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

func exeDir() string {
	exe, err := os.Executable()
	if err != nil {
		if wd, wdErr := os.Getwd(); wdErr == nil {
			return wd
		}
		return "."
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}

func isPluginRoot(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, "lib", "app.js"))
	return err == nil && !info.IsDir()
}

func pluginCandidates() []string {
	var out []string
	if env := strings.TrimSpace(os.Getenv("MIDO_PET_ROOT")); env != "" {
		out = append(out, env)
	}
	base := exeDir()
	out = append(out,
		base,
		filepath.Join(base, "dsh-pet"),
		filepath.Join(base, "dsh-pet", "dsh-pet"),
	)
	home, _ := os.UserHomeDir()
	if home != "" {
		desktop := filepath.Join(home, "Desktop")
		out = append(out,
			filepath.Join(desktop, "dsh-pet"),
			filepath.Join(desktop, "dsh-pet", "dsh-pet"),
		)
	}
	return out
}

func findPluginRoot() (string, error) {
	seen := map[string]bool{}
	var tried []string
	for _, cand := range pluginCandidates() {
		clean, err := filepath.Abs(cand)
		if err != nil {
			continue
		}
		if seen[clean] {
			continue
		}
		seen[clean] = true
		tried = append(tried, clean)
		if isPluginRoot(clean) {
			return clean, nil
		}
	}
	return "", fmt.Errorf("已查找：%s", strings.Join(tried, "、"))
}

func electronName() string {
	if runtime.GOOS == "windows" {
		return "electron.exe"
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join("Electron.app", "Contents", "MacOS", "Electron")
	}
	return "electron"
}

func dshHome() string {
	if env := strings.TrimSpace(os.Getenv("DSH_HOME")); env != "" {
		return env
	}
	home, _ := os.UserHomeDir()
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".dsh")
}

func findElectron() (string, error) {
	var tried []string
	add := func(path string) string {
		if path == "" {
			return ""
		}
		clean, err := filepath.Abs(path)
		if err != nil {
			return ""
		}
		tried = append(tried, clean)
		if info, err := os.Stat(clean); err == nil && !info.IsDir() {
			return clean
		}
		return ""
	}
	if found := add(strings.TrimSpace(os.Getenv("DSH_PET_ELECTRON_PATH"))); found != "" {
		return found, nil
	}
	if found := add(strings.TrimSpace(os.Getenv("ELECTRON_PATH"))); found != "" {
		return found, nil
	}
	if home := dshHome(); home != "" {
		if found := add(filepath.Join(home, "electron", electronName())); found != "" {
			return found, nil
		}
	}
	return "", fmt.Errorf("已查找：%s", strings.Join(tried, "、"))
}

func filteredEnv() []string {
	out := make([]string, 0, len(os.Environ()))
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "ELECTRON_RUN_AS_NODE=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}
