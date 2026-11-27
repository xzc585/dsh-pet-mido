//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	mbOK          = 0x00000000
	mbIconError   = 0x00000010
	mbIconWarning = 0x00000030
	jobKillOnClose = 0x2000
)

var (
	modUser32          = windows.NewLazySystemDLL("user32.dll")
	procMessageBoxW    = modUser32.NewProc("MessageBoxW")
	modKernel32        = windows.NewLazySystemDLL("kernel32.dll")
	procCreateJobObjectW = modKernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject = modKernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = modKernel32.NewProc("AssignProcessToJobObject")
)

func messageBox(title, body string, flags uintptr) {
	t, _ := windows.UTF16PtrFromString(title)
	b, _ := windows.UTF16PtrFromString(body)
	_, _, _ = procMessageBoxW.Call(0, uintptr(unsafe.Pointer(b)), uintptr(unsafe.Pointer(t)), flags)
}

func showError(body string) {
	messageBox("米豆", body, mbOK|mbIconError)
}

type jobObjectExtendedLimitInformation struct {
	BasicLimitInformation struct {
		PerProcessUserTimeLimit int64
		PerJobUserTimeLimit     int64
		LimitFlags              uint32
		MinimumWorkingSetSize   uintptr
		MaximumWorkingSetSize   uintptr
		ActiveProcessLimit      uint32
		Affinity                uintptr
		PriorityClass           uint32
		SchedulingClass         uint32
	}
	IoInfo                [48]byte
	ProcessMemoryLimit    uintptr
	JobMemoryLimit        uintptr
	PeakProcessMemoryUsed uintptr
	PeakJobMemoryUsed     uintptr
}

func assignJob(proc *os.Process) (windows.Handle, error) {
	handle, _, err := procCreateJobObjectW.Call(0, 0)
	if handle == 0 {
		return 0, err
	}
	job := windows.Handle(handle)
	var info jobObjectExtendedLimitInformation
	info.BasicLimitInformation.LimitFlags = jobKillOnClose
	const jobObjectExtendedLimitInformationClass = 9
	r1, _, setErr := procSetInformationJobObject.Call(
		uintptr(job),
		jobObjectExtendedLimitInformationClass,
		uintptr(unsafe.Pointer(&info)),
		unsafe.Sizeof(info),
	)
	if r1 == 0 {
		_ = windows.CloseHandle(job)
		return 0, setErr
	}
	ph, openErr := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(proc.Pid))
	if openErr != nil {
		_ = windows.CloseHandle(job)
		return 0, openErr
	}
	defer windows.CloseHandle(ph)
	r1, _, assignErr := procAssignProcessToJobObject.Call(uintptr(job), uintptr(ph))
	if r1 == 0 {
		_ = windows.CloseHandle(job)
		return 0, assignErr
	}
	return job, nil
}

func main() {
	pluginRoot, err := findPluginRoot()
	if err != nil {
		showError("找不到米豆插件目录（需要其中有 lib\\app.js）。\n\n请把 mido.exe 放在桌面，并保留桌面上的 dsh-pet 文件夹；也可以设置环境变量 MIDO_PET_ROOT 指向插件目录。\n\n" + err.Error())
		os.Exit(1)
	}
	electron, err := findElectron()
	if err != nil {
		showError("找不到桌面运行时（Electron）。\n\n请先打开一次 DeepSeek Harness（desktop 配置）：已安装的米豆插件会自动准备运行时（通常在 %USERPROFILE%\\.dsh\\electron）。也可以设置环境变量 DSH_PET_ELECTRON_PATH 指向 electron.exe。\n\n" + err.Error())
		os.Exit(1)
	}
	appJS := filepath.Join(pluginRoot, "lib", "app.js")
	cmd := exec.Command(electron, appJS)
	cmd.Dir = pluginRoot
	cmd.Env = filteredEnv()
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Start(); err != nil {
		showError("无法启动米豆：\n" + err.Error())
		os.Exit(1)
	}
	job, jobErr := assignJob(cmd.Process)
	if jobErr == nil {
		defer windows.CloseHandle(job)
	}
	err = cmd.Wait()
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			// 单实例锁会让第二次启动立刻以 0 退出；非 0 才提示。
			if exit.ExitCode() != 0 {
				showError(fmt.Sprintf("米豆已退出（代码 %d）。", exit.ExitCode()))
				os.Exit(exit.ExitCode())
			}
			return
		}
		showError("米豆运行失败：\n" + err.Error())
		os.Exit(1)
	}
}
