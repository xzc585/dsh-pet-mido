//go:build windows

package main

import (
	"encoding/json"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

const listenAddr = "127.0.0.1:17341"

type appState struct {
	mu        sync.Mutex
	cfg       Config
	lastClean *CleanReport
	startedAt time.Time
}

type statusPayload struct {
	MemSnap
	IsAdmin   bool         `json:"isAdmin"`
	Config    Config       `json:"config"`
	LastClean *CleanReport `json:"lastClean,omitempty"`
}

func (s *appState) snapshot() statusPayload {
	s.mu.Lock()
	defer s.mu.Unlock()
	mem, _ := readMemory()
	out := statusPayload{MemSnap: mem, IsAdmin: isAdmin(), Config: s.cfg, LastClean: s.lastClean}
	return out
}

func (s *appState) setConfig(cfg Config) error {
	if err := saveConfig(cfg); err != nil {
		return err
	}
	s.mu.Lock()
	s.cfg = cfg
	s.mu.Unlock()
	return nil
}

func (s *appState) runClean() CleanReport {
	rep := cleanMemory()
	s.mu.Lock()
	s.lastClean = &rep
	s.mu.Unlock()
	return rep
}

func (s *appState) payloadWithClean() statusPayload {
	p := s.snapshot()
	return p
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func main() {
	log.SetFlags(0)
	log.SetPrefix("mido-ram-cleaner: ")

	mutex, running := alreadyRunning()
	if running {
		_ = openExistingUI()
		closeMutex(mutex)
		return
	}
	defer closeMutex(mutex)

	oneShot := false
	for _, a := range os.Args[1:] {
		if a == "--clean-once" {
			oneShot = true
		}
	}
	if oneShot {
		rep := cleanMemory()
		if dir, err := appDir(); err == nil {
			raw, _ := json.MarshalIndent(rep, "", "  ")
			_ = os.WriteFile(filepath.Join(dir, "last-clean.json"), append(raw, '\n'), 0o644)
		}
		if rep.Error != "" {
			os.Exit(1)
		}
		return
	}

	state := &appState{cfg: loadConfig(), startedAt: time.Now()}
	if last := readLastCleanFile(); last != nil {
		state.lastClean = last
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(uiHTML)
	})
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "app": "mido-ram-cleaner"})
	})
	mux.HandleFunc("/api/open", func(w http.ResponseWriter, r *http.Request) {
		openSettingsWindow(uiURL())
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	mux.HandleFunc("/api/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, state.snapshot())
	})
	mux.HandleFunc("/api/config", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "请使用 POST")
			return
		}
		var cfg Config
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			writeError(w, http.StatusBadRequest, "设置格式无效")
			return
		}
		if err := state.setConfig(cfg); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, state.snapshot())
	})
	mux.HandleFunc("/api/clean", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "请使用 POST")
			return
		}
		state.runClean()
		writeJSON(w, http.StatusOK, state.payloadWithClean())
	})
	mux.HandleFunc("/api/clean-elevated", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "请使用 POST")
			return
		}
		if isAdmin() {
			state.runClean()
			writeJSON(w, http.StatusOK, state.payloadWithClean())
			return
		}
		if err := relaunchElevated("--clean-once"); err != nil {
			writeError(w, http.StatusInternalServerError, "未能请求管理员权限：可能已取消，或系统不允许提升。仍可使用「立即清理」收缩有权限的工作集。")
			return
		}
		// The elevated process writes last-clean.json; pick it up shortly.
		go func() {
			deadline := time.Now().Add(30 * time.Second)
			for time.Now().Before(deadline) {
				time.Sleep(800 * time.Millisecond)
				if last := readLastCleanFile(); last != nil && last.At.After(state.startedAt.Add(-time.Second)) {
					state.mu.Lock()
					if state.lastClean == nil || last.At.After(state.lastClean.At) {
						state.lastClean = last
					}
					state.mu.Unlock()
					return
				}
			}
		}()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"message": "已发出管理员权限请求。若你同意提升，完整清理会在后台完成，稍后刷新即可看到结果。若取消，仍可用「立即清理」做不需要管理员的部分。",
		})
	})

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		showError("米豆系统内存清理", "无法打开设置窗口服务（"+listenAddr+"）："+err.Error())
		os.Exit(1)
	}
	server := &http.Server{Handler: mux}
	go func() {
		if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Printf("设置窗口服务退出：%v", err)
			requestQuit()
		}
	}()

	go state.autoLoop()
	openSettingsWindow(uiURL())

	if err := startTray(func() {
		openSettingsWindow(uiURL())
	}, func() {
		state.runClean()
	}, func() {
		_ = server.Close()
		requestQuit()
	}); err != nil {
		log.Printf("托盘图标未能创建：%v（设置窗口仍可使用）", err)
		// Keep the process running for the settings UI.
		select {}
	}
	runTrayLoop()
}

func uiURL() string { return "http://" + listenAddr + "/" }

func openExistingUI() error {
	resp, err := http.Get("http://" + listenAddr + "/api/open")
	if err != nil {
		// Best-effort: just open the URL.
		openSettingsWindow(uiURL())
		return err
	}
	defer resp.Body.Close()
	return nil
}

func (s *appState) autoLoop() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for range ticker.C {
		s.mu.Lock()
		cfg := s.cfg
		last := s.lastClean
		started := s.startedAt
		s.mu.Unlock()
		if !cfg.AutoClean {
			continue
		}
		now := time.Now()
		anchor := started
		if last != nil {
			anchor = last.At
		}
		if now.Sub(started) < 10*time.Second {
			continue
		}
		if now.Sub(anchor) < time.Duration(cfg.DebounceSec)*time.Second {
			continue
		}
		mem, err := readMemory()
		if err != nil {
			continue
		}
		due := now.Sub(anchor) >= time.Duration(cfg.IntervalSec)*time.Second
		over := mem.UsedPercent >= float64(cfg.ThresholdPercent)
		if due || over {
			s.runClean()
		}
	}
}

func readLastCleanFile() *CleanReport {
	dir, err := appDir()
	if err != nil {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(dir, "last-clean.json"))
	if err != nil {
		return nil
	}
	var rep CleanReport
	if err := json.Unmarshal(raw, &rep); err != nil {
		return nil
	}
	if rep.At.IsZero() {
		return nil
	}
	return &rep
}

func closeMutex(h windows.Handle) {
	if h != 0 {
		_ = windows.CloseHandle(h)
	}
}
