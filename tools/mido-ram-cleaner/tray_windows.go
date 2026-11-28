//go:build windows

package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	wmApp           = 0x8000
	wmTray          = wmApp + 1
	wmCommand       = 0x0111
	wmDestroy       = 0x0002
	wmClose         = 0x0010
	wmRButtonUp     = 0x0205
	wmLButtonUp     = 0x0202
	wmLButtonDblClk = 0x0203

	nimAdd               = 0x00000000
	nimModify            = 0x00000001
	nimDelete            = 0x00000002
	nifMessage           = 0x00000001
	nifIcon              = 0x00000002
	nifTip               = 0x00000004
	nifInfo              = 0x00000010
	nifRealtime          = 0x00000040
	niifInfo             = 0x00000001
	niifRespectQuietTime = 0x00000080

	tpmLeftAlign   = 0x0000
	tpmRightButton = 0x0002
	mfString       = 0x0000
	mfSeparator    = 0x0800

	idOpen  = 1001
	idClean = 1002
	idExit  = 1003

	imageIcon      = 1
	lrLoadFromFile = 0x0010
	lrDefaultSize  = 0x0040
)

type notifyIconData struct {
	Size             uint32
	Wnd              windows.HWND
	ID               uint32
	Flags            uint32
	CallbackMessage  uint32
	Icon             windows.Handle
	Tip              [128]uint16
	State            uint32
	StateMask        uint32
	Info             [256]uint16
	TimeoutOrVersion uint32
	InfoTitle        [64]uint16
	InfoFlags        uint32
	SharedGUID       windows.GUID
	BalloonIcon      windows.Handle
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

	procRegisterClassExW    = user32.NewProc("RegisterClassExW")
	procCreateWindowExW     = user32.NewProc("CreateWindowExW")
	procDefWindowProcW      = user32.NewProc("DefWindowProcW")
	procGetMessageW         = user32.NewProc("GetMessageW")
	procTranslateMessage    = user32.NewProc("TranslateMessage")
	procDispatchMessageW    = user32.NewProc("DispatchMessageW")
	procPostQuitMessage     = user32.NewProc("PostQuitMessage")
	procPostMessageW        = user32.NewProc("PostMessageW")
	procDestroyWindow       = user32.NewProc("DestroyWindow")
	procCreatePopupMenu     = user32.NewProc("CreatePopupMenu")
	procAppendMenuW         = user32.NewProc("AppendMenuW")
	procTrackPopupMenu      = user32.NewProc("TrackPopupMenu")
	procDestroyMenu         = user32.NewProc("DestroyMenu")
	procGetCursorPos        = user32.NewProc("GetCursorPos")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procLoadImageW          = user32.NewProc("LoadImageW")
	procDestroyIcon         = user32.NewProc("DestroyIcon")
	procLoadIconW           = user32.NewProc("LoadIconW")
	procShellNotifyIconW    = shell32.NewProc("Shell_NotifyIconW")
	procShellExecuteExW     = shell32.NewProc("ShellExecuteExW")
	procGetModuleHandleW    = kernel32.NewProc("GetModuleHandleW")
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
	if h := loadIconFromResource(); h != 0 {
		return h
	}
	return loadIconFromEmbeddedFile()
}

func loadIconFromResource() windows.Handle {
	mod := getModuleHandle()
	// go-winres assigns the application icon group ID 1 (and sometimes 2/3).
	for _, id := range []uintptr{1, 2, 3} {
		h, _, _ := procLoadImageW.Call(uintptr(mod), id, imageIcon, 0, 0, lrDefaultSize)
		if h != 0 {
			return windows.Handle(h)
		}
		h, _, _ = procLoadIconW.Call(uintptr(mod), id)
		if h != 0 {
			return windows.Handle(h)
		}
	}
	return 0
}

func loadIconFromEmbeddedFile() windows.Handle {
	dir, err := appDir()
	if err != nil {
		return loadDefaultIcon()
	}
	path := filepath.Join(dir, "icon.ico")
	// Always refresh the sidecar so upgrades pick up a new Midou icon.
	if writeErr := os.WriteFile(path, iconICO, 0o644); writeErr != nil {
		if _, statErr := os.Stat(path); statErr != nil {
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
		removeTrayIcon(windows.HWND(hwnd))
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
	return updateTrayIcon(nimAdd, &nid)
}

func updateTrayIcon(message uintptr, nid *notifyIconData) error {
	r, _, err := procShellNotifyIconW.Call(message, uintptr(unsafe.Pointer(nid)))
	if r == 0 {
		if err == windows.ERROR_SUCCESS {
			return fmt.Errorf("Shell_NotifyIconW 操作 %d 失败", message)
		}
		return err
	}
	return nil
}

func removeTrayIcon(hwnd windows.HWND) {
	if hwnd == 0 {
		return
	}
	nid := notifyIconData{Size: uint32(unsafe.Sizeof(notifyIconData{})), Wnd: hwnd, ID: 1}
	_ = updateTrayIcon(nimDelete, &nid)
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
	hwnd, err := createHiddenWindow("MidoRamCleanerTray", windows.NewCallback(trayWndProc))
	if err != nil {
		return err
	}
	trayWnd = hwnd
	trayIcon = loadTrayIcon()
	if err := addTrayIcon(trayWnd, trayIcon); err != nil {
		procDestroyWindow.Call(uintptr(trayWnd))
		if trayIcon != 0 {
			procDestroyIcon.Call(uintptr(trayIcon))
		}
		trayWnd, trayIcon = 0, 0
		return err
	}
	return nil
}

func createHiddenWindow(name string, wndProc uintptr) (windows.HWND, error) {
	className := windows.StringToUTF16Ptr(name)
	wc := wndClassEx{
		Size:      uint32(unsafe.Sizeof(wndClassEx{})),
		WndProc:   wndProc,
		Instance:  getModuleHandle(),
		ClassName: className,
	}
	r, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	if r == 0 && err != windows.ERROR_CLASS_ALREADY_EXISTS {
		return 0, err
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
		return 0, err
	}
	return windows.HWND(hwnd), nil
}

func runTrayLoop() {
	runWindowMessageLoop()
	if trayIcon != 0 {
		procDestroyIcon.Call(uintptr(trayIcon))
	}
}

func runWindowMessageLoop() {
	var m msg
	for {
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if int32(r) <= 0 {
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
}

func requestQuit() {
	if trayWnd != 0 {
		procPostMessageW.Call(uintptr(trayWnd), wmClose, 0, 0)
	}
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

type shellExecuteInfo struct {
	Size      uint32
	Mask      uint32
	Wnd       windows.HWND
	Verb      *uint16
	File      *uint16
	Args      *uint16
	Directory *uint16
	Show      int32
	Instance  windows.Handle
	IDList    uintptr
	Class     *uint16
	ClassKey  windows.Handle
	HotKey    uint32
	Icon      windows.Handle
	Process   windows.Handle
}

func relaunchElevated(args string) (func() error, error) {
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	// Shell extensions may use COM. Keep the apartment on the same OS thread.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := windows.CoInitializeEx(0, windows.COINIT_APARTMENTTHREADED); err != nil && err != syscall.Errno(1) {
		return nil, err
	}
	defer windows.CoUninitialize()

	const noCloseProcess = 0x40
	const noAsync = 0x100
	info := shellExecuteInfo{
		Size: uint32(unsafe.Sizeof(shellExecuteInfo{})),
		Mask: noCloseProcess | noAsync,
		Verb: windows.StringToUTF16Ptr("runas"),
		File: windows.StringToUTF16Ptr(exe),
		Args: windows.StringToUTF16Ptr(args),
		Show: windows.SW_HIDE,
	}
	ok, _, err := procShellExecuteExW.Call(uintptr(unsafe.Pointer(&info)))
	if ok == 0 {
		if err == windows.ERROR_SUCCESS {
			return nil, fmt.Errorf("无法启动管理员清理进程")
		}
		return nil, err
	}
	child := info.Process
	if child == 0 {
		return nil, fmt.Errorf("没有取得管理员清理进程句柄")
	}
	return func() error {
		defer windows.CloseHandle(child)
		event, err := windows.WaitForSingleObject(child, windows.INFINITE)
		if err != nil {
			return err
		}
		if event != windows.WAIT_OBJECT_0 {
			return fmt.Errorf("等待管理员清理进程返回 %d", event)
		}
		return nil
	}, nil
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
