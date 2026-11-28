//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"golang.org/x/sys/windows"
)

const listenAddr = "127.0.0.1:17341"
const configVersion = 2

type appState struct {
	mu        sync.Mutex
	cfg       Config
	lastClean *CleanReport
	startedAt time.Time
	cleanMu   sync.Mutex
	clean     func() CleanReport
	notify    func(title, body string)
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

func (s *appState) updateConfig(body io.Reader) error {
	raw, err := io.ReadAll(body)
	if err != nil {
		return errInvalidConfigJSON
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cfg, err := decodeConfig(bytes.NewReader(raw), s.cfg)
	if err != nil {
		return err
	}
	if err := saveConfig(cfg); err != nil {
		return err
	}
	s.cfg = cfg
	return nil
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

	// The elevated child services exactly one request and must not touch the
	// daemon's singleton mutex. It does not listen on the daemon port.
	if len(os.Args) > 1 && os.Args[1] == "--clean-once" {
		if len(os.Args) != 3 || runElevatedChild(os.Args[2], isAdmin(), cleanMemory) != nil {
			os.Exit(1)
		}
		return
	}
	uiMode := false
	for _, arg := range os.Args[1:] {
		if arg == "--ui" {
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

	notifier := &cleanNotifier{}
	defer notifier.close()
	state := &appState{cfg: loadConfig(), startedAt: time.Now(), clean: cleanMemory, notify: notifier.show}
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
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "app": "mido-ram-cleaner", "ui": uiMode, "configVersion": configVersion})
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
		if err := state.updateConfig(r.Body); err != nil {
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
		if _, err := state.runClean(cleanManual); err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, state.snapshot())
	})
	mux.HandleFunc("/api/clean-elevated", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, "请使用 POST")
			return
		}
		if isAdmin() {
			if _, err := state.runClean(cleanElevated); err != nil {
				writeError(w, http.StatusConflict, err.Error())
				return
			}
			writeJSON(w, http.StatusOK, state.snapshot())
			return
		}
		if err := state.startElevatedClean(relaunchElevated); err != nil {
			if err == errCleanInProgress {
				writeError(w, http.StatusConflict, err.Error())
			} else {
				writeError(w, http.StatusInternalServerError, "未能请求管理员权限：可能已取消，或系统不允许提升。仍可使用「立即清理」。")
			}
			return
		}
		writeJSON(w, http.StatusOK, struct {
			statusPayload
			OK      bool   `json:"ok"`
			Message string `json:"message"`
		}{state.snapshot(), true, "已发出管理员权限请求，完整清理会在后台完成。"})
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
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		openSettingsWindow(uiURL())
		if err := startTray(func() {
			openSettingsWindow(uiURL())
		}, func() {
			_, _ = state.runClean(cleanManual)
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
			_, _ = s.runClean(cleanAuto)
		}
	}
}

func readLastCleanFile() *CleanReport {
	dir, err := appDir()
	if err != nil {
		return nil
	}
	return readCleanReport(filepath.Join(dir, "last-clean.json"))
}

func readCleanReport(path string) *CleanReport {
	raw, err := os.ReadFile(path)
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
