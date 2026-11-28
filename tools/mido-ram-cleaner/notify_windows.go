//go:build windows

package main

import (
	"runtime"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const balloonIconLifetime = 30 * time.Second

// The helper normally has no UI or tray. Keep a hidden owner window on its
// own message thread and register the notification icon only as needed.
type cleanNotifier struct {
	mu      sync.Mutex
	window  windows.HWND
	icon    windows.Handle
	visible bool
	timer   *time.Timer
	serial  uint64
	closed  bool
}

func (n *cleanNotifier) show(title, body string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.closed {
		return
	}
	if n.window == 0 {
		hwnd, err := startBalloonWindow()
		if err != nil {
			writeAppLog("无法创建清理通知窗口：" + err.Error())
			return
		}
		n.window = hwnd
		n.icon = loadTrayIcon()
	}
	if !n.visible {
		if err := addTrayIcon(n.window, n.icon); err != nil {
			writeAppLog("无法创建清理通知图标：" + err.Error())
			return
		}
		n.visible = true
	}
	nid := notifyIconData{
		Size: uint32(unsafe.Sizeof(notifyIconData{})), Wnd: n.window, ID: 1,
		Flags: nifInfo | nifRealtime, InfoFlags: niifInfo | niifRespectQuietTime,
	}
	copyUTF16(nid.InfoTitle[:], title)
	copyUTF16(nid.Info[:], body)
	if err := updateTrayIcon(nimModify, &nid); err != nil {
		n.removeIcon()
		writeAppLog("无法显示清理通知：" + err.Error())
		return
	}
	if n.timer != nil {
		n.timer.Stop()
	}
	n.serial++
	serial := n.serial
	n.timer = time.AfterFunc(balloonIconLifetime, func() {
		n.mu.Lock()
		defer n.mu.Unlock()
		if serial == n.serial {
			n.removeIcon()
			n.timer = nil
		}
	})
}

func (n *cleanNotifier) removeIcon() {
	if n.visible {
		removeTrayIcon(n.window)
		n.visible = false
	}
}

func (n *cleanNotifier) close() {
	n.mu.Lock()
	defer n.mu.Unlock()
	n.closed = true
	n.serial++
	if n.timer != nil {
		n.timer.Stop()
		n.timer = nil
	}
	n.removeIcon()
	if n.icon != 0 {
		procDestroyIcon.Call(uintptr(n.icon))
		n.icon = 0
	}
	if n.window != 0 {
		procPostMessageW.Call(uintptr(n.window), wmClose, 0, 0)
		n.window = 0
	}
}

func startBalloonWindow() (windows.HWND, error) {
	type result struct {
		hwnd windows.HWND
		err  error
	}
	created := make(chan result, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		hwnd, err := createHiddenWindow("MidoRamCleanerBalloon", windows.NewCallback(balloonWndProc))
		created <- result{hwnd, err}
		if err == nil {
			runWindowMessageLoop()
		}
	}()
	out := <-created
	return out.hwnd, out.err
}

func balloonWndProc(hwnd uintptr, message uint32, wParam, lParam uintptr) uintptr {
	if message == wmDestroy {
		procPostQuitMessage.Call(0)
		return 0
	}
	result, _, _ := procDefWindowProcW.Call(hwnd, uintptr(message), wParam, lParam)
	return result
}
