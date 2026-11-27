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

	uiMode := false
	oneShot := false
	for _, a := range os.Args[1:] {
		switch a {
		case "--clean-once":
			oneShot = true
		case "--ui":
			uiMode = true
		}
	}

	mutex, running := alreadyRunning()
	if running {
		// Default is headless: a second launch is a no-op because the API is already up.
		// --ui still asks the existing process to show the debug window.
		if uiMode {
			_ = openExistingUI()
		}
		closeMutex(mutex)
		return
	}
	defer closeMutex(mutex)

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

	quitCh := make(chan struct{})
	var quitOnce sync.Once
	signalQuit := func() {
		quitOnce.Do(func() { close(quitCh) })
	}

	var server *http.Server
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
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "app": "mido-ram-cleaner", "ui": uiMode})
	})
	mux.HandleFunc("/api/open", func(w http.ResponseWriter, r *http.Request) {
		if uiMode {
			openSettingsWindow(uiURL())
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "ui": uiMode})
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
	mux.HandleFunc("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "请使用 POST")
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		go func() {
			time.Sleep(50 * time.Millisecond)
			if server != nil {
				_ = server.Close()
			}
			signalQuit()
		}()
	})

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		writeAppLog("无法监听 " + listenAddr + "：" + err.Error())
		if uiMode {
			showError("米豆系统内存清理", "无法打开本机接口（"+listenAddr+"）："+err.Error())
		}
		os.Exit(1)
	}
	server = &http.Server{Handler: mux}
	go func() {
		if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
			writeAppLog("本机接口退出：" + err.Error())
			signalQuit()
		}
	}()

	go state.autoLoop()

	// Default: no settings window, no tray, no visible UI. The plugin talks to the API.
	if uiMode {
		openSettingsWindow(uiURL())
		if err := startTray(func() {
			openSettingsWindow(uiURL())
		}, func() {
			state.runClean()
		}, func() {
			_ = server.Close()
			signalQuit()
			requestQuit()
		}); err != nil {
			writeAppLog("托盘图标未能创建：" + err.Error())
			<-quitCh
			return
		}
		go func() {
			<-quitCh
			requestQuit()
		}()
		runTrayLoop()
		return
	}

	<-quitCh
}

func uiURL() string { return "http://" + listenAddr + "/" }

func openExistingUI() error {
	resp, err := http.Get("http://" + listenAddr + "/api/open")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return nil
}

func writeAppLog(msg string) {
	log.Print(msg)
	dir, err := appDir()
	if err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, "helper.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(time.Now().Format(time.RFC3339) + " " + msg + "\n")
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
