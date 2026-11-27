//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wmApp          = 0x8000
	wmTray         = wmApp + 1
	wmCommand      = 0x0111
	wmDestroy      = 0x0002
	wmRButtonUp    = 0x0205
	wmLButtonUp    = 0x0202
	wmLButtonDblClk = 0x0203

	nimAdd    = 0x00000000
	nimDelete = 0x00000002
	nifMessage = 0x00000001
	nifIcon    = 0x00000002
	nifTip     = 0x00000004

	tpmLeftAlign  = 0x0000
	tpmRightButton = 0x0002
	mfString      = 0x0000
	mfSeparator   = 0x0800

	idOpen  = 1001
	idClean = 1002
	idExit  = 1003

	imageIcon     = 1
	lrLoadFromFile = 0x0010
	lrDefaultSize  = 0x0040
)

type notifyIconData struct {
	Size            uint32
	Wnd             windows.HWND
	ID              uint32
	Flags           uint32
	CallbackMessage uint32
	Icon            windows.Handle
	Tip             [128]uint16
}

type point struct{ X, Y int32 }

type msg struct {
	Hwnd    windows.HWND
	Message uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	Pt      point
}

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       windows.Handle
	Cursor     windows.Handle
	Background windows.Handle
	MenuName   *uint16
	ClassName  *uint16
	IconSm     windows.Handle
}

var (
	user32   = windows.NewLazySystemDLL("user32.dll")
	shell32  = windows.NewLazySystemDLL("shell32.dll")
	kernel32 = windows.NewLazySystemDLL("kernel32.dll")

	procRegisterClassExW     = user32.NewProc("RegisterClassExW")
	procCreateWindowExW      = user32.NewProc("CreateWindowExW")
	procDefWindowProcW       = user32.NewProc("DefWindowProcW")
	procGetMessageW          = user32.NewProc("GetMessageW")
	procTranslateMessage     = user32.NewProc("TranslateMessage")
	procDispatchMessageW     = user32.NewProc("DispatchMessageW")
	procPostQuitMessage      = user32.NewProc("PostQuitMessage")
	procDestroyWindow        = user32.NewProc("DestroyWindow")
	procCreatePopupMenu      = user32.NewProc("CreatePopupMenu")
	procAppendMenuW          = user32.NewProc("AppendMenuW")
	procTrackPopupMenu       = user32.NewProc("TrackPopupMenu")
	procDestroyMenu          = user32.NewProc("DestroyMenu")
	procGetCursorPos         = user32.NewProc("GetCursorPos")
	procSetForegroundWindow  = user32.NewProc("SetForegroundWindow")
	procLoadImageW           = user32.NewProc("LoadImageW")
	procDestroyIcon          = user32.NewProc("DestroyIcon")
	procLoadIconW            = user32.NewProc("LoadIconW")
	procShellNotifyIconW     = shell32.NewProc("Shell_NotifyIconW")
	procGetModuleHandleW     = kernel32.NewProc("GetModuleHandleW")
)

var (
	trayWnd  windows.HWND
	trayIcon windows.Handle
	onOpen   func()
	onClean  func()
	onExit   func()
)

func getModuleHandle() windows.Handle {
	h, _, _ := procGetModuleHandleW.Call(0)
	return windows.Handle(h)
}

func loadTrayIcon() windows.Handle {
	dir, err := appDir()
	if err != nil {
		return loadDefaultIcon()
	}
	path := filepath.Join(dir, "icon.ico")
	if _, err := os.Stat(path); err != nil {
		if writeErr := os.WriteFile(path, iconICO, 0o644); writeErr != nil {
			return loadDefaultIcon()
		}
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return loadDefaultIcon()
	}
	h, _, _ := procLoadImageW.Call(0, uintptr(unsafe.Pointer(p)), imageIcon, 0, 0, lrLoadFromFile|lrDefaultSize)
	if h == 0 {
		return loadDefaultIcon()
	}
	return windows.Handle(h)
}

func loadDefaultIcon() windows.Handle {
	// IDI_APPLICATION
	h, _, _ := procLoadIconW.Call(0, uintptr(32512))
	return windows.Handle(h)
}

func trayWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case wmTray:
		switch lParam {
		case wmLButtonUp, wmLButtonDblClk:
			if onOpen != nil {
				onOpen()
			}
		case wmRButtonUp:
			showTrayMenu(windows.HWND(hwnd))
		}
		return 0
	case wmCommand:
		switch uint16(wParam) {
		case idOpen:
			if onOpen != nil {
				onOpen()
			}
		case idClean:
			if onClean != nil {
				onClean()
			}
		case idExit:
			if onExit != nil {
				onExit()
			} else {
				procPostQuitMessage.Call(0)
			}
		}
		return 0
	case wmDestroy:
		removeTrayIcon()
		procPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return r
}

func showTrayMenu(hwnd windows.HWND) {
	menu, _, _ := procCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	defer procDestroyMenu.Call(menu)
	appendMenu(menu, mfString, idOpen, "打开设置")
	appendMenu(menu, mfString, idClean, "立即清理")
	appendMenu(menu, mfSeparator, 0, "")
	appendMenu(menu, mfString, idExit, "退出")

	var pt point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	procSetForegroundWindow.Call(uintptr(hwnd))
	procTrackPopupMenu.Call(menu, tpmLeftAlign|tpmRightButton, uintptr(pt.X), uintptr(pt.Y), 0, uintptr(hwnd), 0)
}

func appendMenu(menu uintptr, flags, id uint32, text string) {
	p, _ := windows.UTF16PtrFromString(text)
	procAppendMenuW.Call(menu, uintptr(flags), uintptr(id), uintptr(unsafe.Pointer(p)))
}

func addTrayIcon(hwnd windows.HWND, icon windows.Handle) error {
	var nid notifyIconData
	nid.Size = uint32(unsafe.Sizeof(nid))
	nid.Wnd = hwnd
	nid.ID = 1
	nid.Flags = nifMessage | nifIcon | nifTip
	nid.CallbackMessage = wmTray
	nid.Icon = icon
	copyUTF16(nid.Tip[:], "米豆系统内存清理")
	r, _, err := procShellNotifyIconW.Call(nimAdd, uintptr(unsafe.Pointer(&nid)))
	if r == 0 {
		return err
	}
	return nil
}

func removeTrayIcon() {
	if trayWnd == 0 {
		return
	}
	var nid notifyIconData
	nid.Size = uint32(unsafe.Sizeof(nid))
	nid.Wnd = trayWnd
	nid.ID = 1
	procShellNotifyIconW.Call(nimDelete, uintptr(unsafe.Pointer(&nid)))
}

func copyUTF16(dst []uint16, s string) {
	src := windows.StringToUTF16(s)
	if len(src) > len(dst) {
		src = src[:len(dst)]
		src[len(dst)-1] = 0
	}
	copy(dst, src)
}

func startTray(open, clean, exit func()) error {
	onOpen, onClean, onExit = open, clean, exit
	className, _ := windows.UTF16PtrFromString("MidoRamCleanerTray")
	wndProc := windows.NewCallback(trayWndProc)
	wc := wndClassEx{
		Size:      uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:   wndProc,
		Instance:  getModuleHandle(),
		ClassName: className,
	}
	r, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	if r == 0 && err != nil && err != windows.ERROR_CLASS_ALREADY_EXISTS && err != windows.ERROR_SUCCESS {
		return err
	}
	// Hidden message-only-style window used solely for tray callbacks.
	hwnd, _, err := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(className)),
		0, 0, 0, 0, 0,
		0, 0, uintptr(getModuleHandle()), 0,
	)
	if hwnd == 0 {
		return err
	}
	trayWnd = windows.HWND(hwnd)
	trayIcon = loadTrayIcon()
	if err := addTrayIcon(trayWnd, trayIcon); err != nil {
		return err
	}
	return nil
}

func runTrayLoop() {
	var m msg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	if trayIcon != 0 {
		procDestroyIcon.Call(uintptr(trayIcon))
	}
}

func requestQuit() {
	procPostQuitMessage.Call(0)
}

func openSettingsWindow(url string) {
	if tryAppWindow(url) {
		return
	}
	openDefaultBrowser(url)
}

func tryAppWindow(url string) bool {
	candidates := []string{
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Google\Chrome\Application\chrome.exe`,
		`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
	}
	for _, exe := range candidates {
		if _, err := os.Stat(exe); err != nil {
			continue
		}
		cmd := windows.StringToUTF16Ptr(`"` + exe + `" --app=` + url)
		exePtr := windows.StringToUTF16Ptr(exe)
		var si windows.StartupInfo
		si.Cb = uint32(unsafe.Sizeof(si))
		var pi windows.ProcessInformation
		err := windows.CreateProcess(exePtr, cmd, nil, nil, false, 0, nil, nil, &si, &pi)
		if err == nil {
			windows.CloseHandle(pi.Thread)
			windows.CloseHandle(pi.Process)
			return true
		}
	}
	return false
}

func openDefaultBrowser(url string) {
	_ = windows.ShellExecute(0, windows.StringToUTF16Ptr("open"), windows.StringToUTF16Ptr(url), nil, nil, windows.SW_SHOWNORMAL)
}

func relaunchElevated(args string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	verb, _ := windows.UTF16PtrFromString("runas")
	file, _ := windows.UTF16PtrFromString(exe)
	param, _ := windows.UTF16PtrFromString(args)
	err = windows.ShellExecute(0, verb, file, param, nil, windows.SW_SHOWNORMAL)
	if err != nil && err != windows.ERROR_SUCCESS {
		return err
	}
	return nil
}

func alreadyRunning() (windows.Handle, bool) {
	name, _ := windows.UTF16PtrFromString("Local\\mido-ram-cleaner")
	mod := windows.NewLazySystemDLL("kernel32.dll")
	proc := mod.NewProc("CreateMutexW")
	h, _, err := proc.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if h == 0 {
		return 0, false
	}
	if err == windows.ERROR_ALREADY_EXISTS {
		return windows.Handle(h), true
	}
	return windows.Handle(h), false
}

func showError(title, text string) {
	tPtr, _ := windows.UTF16PtrFromString(title)
	mPtr, _ := windows.UTF16PtrFromString(text)
	proc := user32.NewProc("MessageBoxW")
	proc.Call(0, uintptr(unsafe.Pointer(mPtr)), uintptr(unsafe.Pointer(tPtr)), 0x10)
}

// silence unused import if syscall is only needed for some builds
var _ = syscall.Errno(0)
